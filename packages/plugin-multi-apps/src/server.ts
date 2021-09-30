import { Application, PluginOptions } from '@nocobase/server';
import Koa from 'koa';
import { Model } from '@nocobase/database';
import { readFileSync } from 'fs';
import glob from 'glob';
import path from 'path';

function getInitSqls() {
  const part1 = [];
  const part2 = [];
  const files1 = glob.sync(path.resolve(__dirname, './db/part1/*.sql'));
  for (const file of files1) {
    const sql = readFileSync(file).toString();
    part1.push(sql);
  }
  const files2 = glob.sync(path.resolve(__dirname, './db/part2/*.sql'));
  for (const file of files2) {
    const sql = readFileSync(file).toString();
    part2.push(sql);
  }
  return { part1, part2 };
}

function createApp(opts) {
  const { name } = opts;
  const options = {
    database: {
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: name,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT as any,
      dialect: process.env.DB_DIALECT as any,
      dialectOptions: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      },
      pool: {
        max: 5,
        min: 0,
        acquire: 60000,
        idle: 10000,
      },
      // logging: process.env.DB_LOG_SQL === 'on' ? console.log : false,
      define: {},
      sync: {
        force: false,
        alter: {
          drop: false,
        },
      },
    },
    // 不能再 bodyParser，会卡死
    // bodyParser: false,
    // dataWrapping: false,
    resourcer: {
      prefix: '/api',
      // prefix: `/api/multiapps/${name}`,
    },
  };
  const app = new Application(options);

  // app.db.sequelize.beforeDefine((model, options) => {
  //   options.tableName = `multiapps_${name}_${
  //     options.tableName || options.name.plural
  //   }`;
  // });

  const plugins = [
    '@nocobase/plugin-ui-router',
    '@nocobase/plugin-ui-schema',
    '@nocobase/plugin-collections',
    '@nocobase/plugin-users',
    '@nocobase/plugin-action-logs',
    '@nocobase/plugin-file-manager',
    '@nocobase/plugin-permissions',
    '@nocobase/plugin-export',
    '@nocobase/plugin-system-settings',
    '@nocobase/plugin-china-region',
  ];

  for (const plugin of plugins) {
    app.plugin(
      require(`${plugin}/${__filename.endsWith('.ts') ? 'src' : 'lib'}/server`)
        .default,
    );
  }

  return app;
}

function multiApps({ getAppName }) {
  return async function (ctx: Koa.Context, next) {
    const appName = getAppName(ctx);
    console.log({ appName });
    if (!appName) {
      return next();
    }
    // @ts-ignore
    const App = ctx.app.db.getModel('applications');
    const model = await App.findOne({
      where: { name: appName },
    });
    if (!model) {
      return next();
    }
    const apps = ctx.app['apps'];
    if (!apps.has(appName)) {
      const app = createApp({
        name: appName,
      });
      await app.load();
      apps.set(appName, app);
    }

    console.log('..........................start........................');
    // 完全隔离的做法
    const app = apps.get(appName) as Application;
    // @ts-ignore
    console.log(app.db.options);
    const bodyParser = async (ctx2, next) => {
      // @ts-ignore
      // ctx2.request.body = ctx.request.body || {};
      await next();
    };
    app.middleware.unshift(bodyParser);
    const handleRequest = app.callback();
    await handleRequest(ctx.req, ctx.res);
    const index = app.middleware.indexOf(bodyParser);
    app.middleware.splice(index, 1);
    console.log('..........................end........................');
    // await next();
  };
}

export default {
  name: 'saas',
  async load() {
    this.app['apps'] = new Map<string, Application>();
    this.app.collection({
      name: 'applications',
      title: '应用',
      fields: [
        {
          type: 'uid',
          name: 'name',
          prefix: 'a',
          interface: 'string',
          unique: true,
          uiSchema: {
            type: 'string',
            title: '应用标识',
            'x-component': 'Input',
          },
        },
        {
          type: 'string',
          name: 'title',
          interface: 'string',
          unique: true,
          uiSchema: {
            type: 'string',
            title: '应用名称',
            'x-component': 'Input',
          },
        },
        {
          type: 'string',
          name: 'status',
          interface: 'select',
          uiSchema: {
            type: 'string',
            title: '状态',
            'x-component': 'Select',
            default: 'initializing',
            enum: [
              { value: 'initializing', label: '正在初始化' },
              { value: 'running', label: '运行中' },
              { value: 'stopped', label: '已停止' },
            ],
          },
        },
      ],
    });
    this.app.middleware.unshift(multiApps({
      getAppName(ctx) {
        const hostname = ctx.get('X-Hostname');
        if (!hostname) {
          return;
        }
        const keys = hostname.split('.');
        if (keys.length < 4) {
          return;
        }
        console.log('ctx.hostname', ctx.get('X-Hostname'));
        return keys.shift();
      },
    }));
    this.app.db.on('applications.afterCreate', async (model: Model) => {
      const name = model.get('name');
      (async () => {
        await this.app.db.sequelize.query(`CREATE DATABASE "${name}";`);
        const app = createApp({
          name,
        });
        console.log('creating........')
        await app.load();
        await app.db.sync({
          force: true,
          alter: {
            drop: true,
          },
        });
        await app.emitAsync('beforeStart');
        await app.emitAsync('db.init');
        const transaction = await app.db.sequelize.transaction();
        const sqls = getInitSqls();
        try {
          for (const sql of sqls.part1) {
            await app.db.sequelize.query(sql, { transaction });
          }
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
        }
        await app.db.getModel('collections').load({
          skipExisting: true,
        });
        await app.db.sync();
        const transaction2 = await app.db.sequelize.transaction();
        try {
          for (const sql of sqls.part2) {
            await app.db.sequelize.query(sql, { transaction: transaction2 });
          }
          await transaction2.commit();
        } catch (error) {
          await transaction2.rollback();
        }
        this.app['apps'].set(name, app);
        model.set('status', 'running');
        await model.save({ hooks: false });
      })();
    });
    this.app
      .command('app:db:sync')
      .argument('<appName>')
      .action(async (appName) => {
        const app = createApp({
          name: appName,
        });
        await app.load();
        await app.emitAsync('beforeStart');
        await app.db.sync();
        await app.destroy();
        await this.app.destroy();
      });

    this.app
      .command('app:create')
      .argument('<appName>')
      .action(async (name) => {
        await this.app.db.sequelize.query(`CREATE DATABASE "${name}";`);
        const app = createApp({
          name,
        });
        console.log('creating........')
        await app.load();
        await app.db.sync({
          force: true,
          alter: {
            drop: true,
          },
        });
        await app.emitAsync('beforeStart');
        await app.emitAsync('db.init');
        const transaction = await app.db.sequelize.transaction();
        const sqls = getInitSqls();
        try {
          for (const sql of sqls.part1) {
            await app.db.sequelize.query(sql, { transaction });
          }
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
        }
        await app.db.getModel('collections').load({
          skipExisting: true,
        });
        await app.db.sync();
        const transaction2 = await app.db.sequelize.transaction();
        try {
          for (const sql of sqls.part2) {
            await app.db.sequelize.query(sql, { transaction: transaction2 });
          }
          await transaction2.commit();
        } catch (error) {
          await transaction2.rollback();
        }
        await app.destroy();
        await this.app.destroy();
      });
  },
} as PluginOptions;
