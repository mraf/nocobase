import { Mutex } from 'async-mutex';
import { isNumber } from 'lodash';
import { DataTypes } from 'sequelize';
import { BaseColumnFieldOptions, Field } from './field';

const sortFieldMutex = new Mutex();

export class SortField extends Field {
  get dataType() {
    return DataTypes.BIGINT;
  }

  setSortValue = async (instance, options) => {
    const { name, scopeKey } = this.options;
    const { model } = this.context.collection;

    if (isNumber(instance.get(name)) && instance._previousDataValues[scopeKey] == instance[scopeKey]) {
      return;
    }

    const where = {};

    if (scopeKey) {
      const value = instance.get(scopeKey);
      if (value !== undefined && value !== null) {
        where[scopeKey] = value;
      }
    }

    await sortFieldMutex.runExclusive(async () => {
      const max = await model.max<number, any>(name, { ...options, where });
      const newValue = (max || 0) + 1;
      instance.set(name, newValue);
    });
  };

  onScopeChange = async (instance, options) => {
    const { scopeKey } = this.options;
    if (scopeKey && !instance.isNewRecord && instance._previousDataValues[scopeKey] != instance[scopeKey]) {
      await this.setSortValue(instance, options);
    }
  };

  initRecordsSortValue = async ({ transaction }) => {
    const orderField = (() => {
      const model = this.collection.model;
      if (model.primaryKeyAttribute) {
        return model.primaryKeyAttribute;
      }
      if (model.rawAttributes['createdAt']) {
        return model.rawAttributes['createdAt'].field;
      }

      throw new Error(`can not find order key for collection ${this.collection.name}`);
    })();

    const needInit = async (scopeKey = null, scopeValue = null) => {
      const filter = {};
      if (scopeKey && scopeValue) {
        filter[scopeKey] = scopeValue;
      }

      const totalCount = await this.collection.repository.count({
        filter,
        transaction,
      });

      const emptyCount = await this.collection.repository.count({
        filter: {
          [this.name]: null,
          ...filter,
        },
        transaction,
      });

      return emptyCount === totalCount && emptyCount > 0;
    };

    const doInit = async (scopeKey = null, scopeValue = null) => {
      const queryInterface = this.collection.db.sequelize.getQueryInterface();

      const quotedOrderField = queryInterface.quoteIdentifier(orderField);

      const sql = `
        WITH ordered_table AS (
          SELECT *, ROW_NUMBER() OVER (${
            scopeKey ? `PARTITION BY ${queryInterface.quoteIdentifier(scopeKey)}` : ''
          } ORDER BY ${quotedOrderField}) AS new_sequence_number
          FROM ${this.collection.quotedTableName()}
          ${
            scopeKey
              ? `WHERE ${queryInterface.quoteIdentifier(scopeKey)} IN (${scopeValue.map((v) => `'${v}'`).join(',')})`
              : ''
          }
        )
        ${
          this.collection.db.inDialect('mysql')
            ? `
             UPDATE ${this.collection.quotedTableName()}, ordered_table
             SET ${this.collection.quotedTableName()}.${this.name} = ordered_table.new_sequence_number
             WHERE ${this.collection.quotedTableName()}.${quotedOrderField} = ordered_table.${quotedOrderField}
                ${scopeKey ? `AND ${this.collection.quotedTableName()}.${scopeKey} = ordered_table.${scopeKey}` : ''}
            `
            : `
          UPDATE ${this.collection.quotedTableName()}
        SET ${queryInterface.quoteIdentifier(this.name)} = ordered_table.new_sequence_number
        FROM ordered_table
        WHERE ${this.collection.quotedTableName()}.${quotedOrderField} = ${queryInterface.quoteIdentifier(
                'ordered_table',
              )}.${quotedOrderField};
        `
        }

      `;

      await this.collection.db.sequelize.query(sql, {
        transaction,
      });
    };

    const scopeKey = this.options.scopeKey;
    if (scopeKey) {
      const groups = await this.collection.repository.find({
        attributes: [scopeKey],
        group: [scopeKey],
        raw: true,
        transaction,
      });

      const needInitGroups = [];
      for (const group of groups) {
        if (await needInit(scopeKey, group[scopeKey])) {
          needInitGroups.push(group['group']);
        }
      }

      if (needInitGroups.length > 0) {
        await doInit(scopeKey, needInitGroups);
      }
    } else if (await needInit()) {
      await doInit();
    }
  };

  bind() {
    super.bind();
    this.on('afterSync', this.initRecordsSortValue);
    this.on('beforeUpdate', this.onScopeChange);
    this.on('beforeCreate', this.setSortValue);
  }

  unbind() {
    super.unbind();
    this.off('beforeUpdate', this.onScopeChange);
    this.off('beforeCreate', this.setSortValue);
    this.off('afterSync', this.initRecordsSortValue);
  }
}

export interface SortFieldOptions extends BaseColumnFieldOptions {
  type: 'sort';
  scopeKey?: string;
}
