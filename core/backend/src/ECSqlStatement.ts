/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
/** @module ECSQL */

import { DbResult, BentleyStatus, Id64, Id64Props, Guid, GuidProps, IDisposable, StatusCodeWithMessage } from "@bentley/bentleyjs-core";
import { IModelError, ECSqlValueType, ECSqlTypedString, ECSqlStringType, NavigationValue, NavigationBindingValue, ECSqlSystemProperty, ECJsNames } from "@bentley/imodeljs-common";
import { XAndY, XYAndZ, XYZ, LowAndHighXYZ, Range3d } from "@bentley/geometry-core";
import { ECDb } from "./ECDb";
import { NativePlatformRegistry } from "./NativePlatformRegistry";
import { NativeECSqlStatement, NativeECSqlBinder, NativeECSqlValue, NativeECSqlValueIterator, NativeECDb, NativeDgnDb } from "@bentley/imodeljs-native-platform-api";

/** The result of an **ECSQL INSERT** statement as returned from [ECSqlStatement.stepForInsert]($imodeljs-backend.ECSqlStatement.stepForInsert).
 *
 * > Insert statements can be used with ECDb only, not with IModelDb.
 *
 * If the step was successful, the ECSqlInsertResult contains
 * [DbResult.BE_SQLITE_DONE]($bentleyjs-core.DbResult.BE_SQLITE_DONE)
 * and the ECInstanceId of the newly created instance.
 * In case of failure it contains the [DbResult]($bentleyjs-core.DbResult) error code.
 */
export class ECSqlInsertResult {
  public constructor(public status: DbResult, public id?: Id64) { }
}

/** An ECSQL Statement.
 *
 * A statement must be prepared before it can be executed, and it must be released when no longer needed.
 * See [IModelDb.withPreparedStatement]($imodeljs-backend.IModelDb.withPreparedStatement) or
 * [ECDb.withPreparedStatement]($imodeljs-backend.ECDb.withPreparedStatement) for a convenient and
 * reliable way to prepare, execute, and then release a statement.
 *
 * A statement may contain parameters that must be filled in before use by the **bind** methods.
 *
 * Once prepared (and parameters are bound, if any), the statement is executed by calling [ECSqlStatement.step]($imodeljs-backend.ECSqlStatement.step).
 * In case of an **ECSQL SELECT** statement, the current row can be retrieved with [ECSqlStatement.getRow]($imodeljs-backend.ECSqlStatement.getRow) as
 * a whole, or with [ECSqlStatement.getValue]($imodeljs-backend.ECSqlStatement.getValue) when individual values are needed.
 * Alternatively, query results of an **ECSQL SELECT** statement can be stepped through by using
 * standard iteration syntax, such as `for of`.
 *
 * > Preparing a statement can be time-consuming. The best way to reduce the effect of this overhead is to cache and reuse prepared
 * > statements. A cached prepared statement may be used in different places in an app, as long as the statement is general enough.
 * > The key to making this strategy work is to phrase a statement in a general way and use placeholders to represent parameters that will vary on each use.
 *
 * #### Example:
 *
 * ```ts
 * [[include:ECSqlStatement.Examples]]
 * ```
 *
 * See [Executing ECSQL]($docs/learning/backend/ExecutingECSQL) for more on ECSQL.
 */
export class ECSqlStatement implements IterableIterator<any>, IDisposable {
  private _stmt: NativeECSqlStatement | undefined;
  private _isShared: boolean = false;

  /** @hidden - used by statement cache */
  public setIsShared(b: boolean) { this._isShared = b; }

  /** @hidden - used by statement cache */
  public isShared(): boolean { return this._isShared; }

  /** Check if this statement has been prepared successfully or not */
  public isPrepared(): boolean { return this._stmt !== undefined; }

  /** @hidden used internally only
   * Prepare this statement prior to first use.
   * @param db The DgnDb or ECDb to prepare the statement against
   * @param ecsql The ECSQL statement string to prepare
   * @throws [IModelError]($imodeljs-common.IModelError) if the ECSQL statement cannot be prepared. Normally, prepare fails due to ECSQL syntax errors or references to tables or properties that do not exist.
   * The error.message property will provide details.
   */
  public prepare(db: NativeDgnDb | NativeECDb, ecsql: string): void {
    if (this.isPrepared())
      throw new Error("ECSqlStatement is already prepared");
    this._stmt = new (NativePlatformRegistry.getNativePlatform()).NativeECSqlStatement();
    const stat: StatusCodeWithMessage<DbResult> = this._stmt!.prepare(db, ecsql);
    if (stat.status !== DbResult.BE_SQLITE_OK)
      throw new IModelError(stat.status, stat.message);
  }

  /** Reset this statement so that the next call to step will return the first row, if any.
   */
  public reset(): void {
    if (!this._stmt)
      throw new Error("ECSqlStatement is not prepared");

    this._stmt.reset();
  }

  /** Call this function when finished with this statement. This releases the native resources held by the statement.
   *
   * > Do not call this method directly on a statement that is being managed by a statement cache.
   */
  public dispose(): void {
    if (this.isShared())
      throw new Error("you can't dispose an ECSqlStatement that is shared with others (e.g., in a cache)");
    if (!this.isPrepared())
      return;
    this._stmt!.dispose(); // Tell the peer JS object to free its native resources immediately
    this._stmt = undefined; // discard the peer JS object as garbage
  }

  /** Binds null to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   */
  public bindNull(parameter: number | string): void { this.getBinder(parameter).bindNull(); }

  /** Binds a BLOB value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param BLOB value as either an ArrayBuffer or a Base64 string
   */
  public bindBlob(parameter: number | string, blob: string | ArrayBuffer | SharedArrayBuffer): void { this.getBinder(parameter).bindBlob(blob); }

  /** Binds a boolean value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Boolean value
   */
  public bindBoolean(parameter: number | string, val: boolean): void { this.getBinder(parameter).bindBoolean(val); }

  /** Binds a DateTime value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param isoDateTimeString DateTime value as ISO8601 string
   */
  public bindDateTime(parameter: number | string, isoDateTimeString: string): void { this.getBinder(parameter).bindDateTime(isoDateTimeString); }

  /** Binds a double value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Double value
   */
  public bindDouble(parameter: number | string, val: number): void { this.getBinder(parameter).bindDouble(val); }

  /** Binds an GUID value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val GUID value
   */
  public bindGuid(parameter: number | string, val: GuidProps): void { this.getBinder(parameter).bindGuid(ECSqlTypeHelper.toGuidString(val)); }

  /** Binds an Id value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Id value
   */
  public bindId(parameter: number | string, val: Id64Props): void { this.getBinder(parameter).bindId(ECSqlTypeHelper.toIdString(val)); }

  /** Binds an integer value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Integer value as number, decimal string or hexadecimal string.
   */
  public bindInteger(parameter: number | string, val: number | string): void { this.getBinder(parameter).bindInteger(val); }

  /** Binds an Point2d value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Point2d value
   */
  public bindPoint2d(parameter: number | string, val: XAndY): void { this.getBinder(parameter).bindPoint2d(val.x, val.y); }

  /** Binds an Point3d value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Point3d value
   */
  public bindPoint3d(parameter: number | string, val: XYAndZ): void { this.getBinder(parameter).bindPoint3d(val.x, val.y, val.z); }

  /** Binds a Range3d as a blob to the specified ECSQL parameter
   * @param parameter Index(1-based) or name of the parameter
   * @param val Range3d value
   */
  public bindRange3d(parameter: number | string, val: LowAndHighXYZ): void { this.bindBlob(parameter, Range3d.toFloat64Array(val).buffer); }

  /** Binds an string to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val String value
   */
  public bindString(parameter: number | string, val: string): void { this.getBinder(parameter).bindString(val); }

  /** Binds a navigation property value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Navigation property value
   */
  public bindNavigation(parameter: number | string, val: NavigationBindingValue): void { this.getBinder(parameter).bindNavigation(ECSqlTypeHelper.toIdString(val.id), val.relClassName, val.relClassTableSpace); }

  /** Binds a struct property value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Struct value. The struct value is an object composed of pairs of a struct member property name and its value
   * (of one of the supported types)
   */
  public bindStruct(parameter: number | string, val: object): void { ECSqlBindingHelper.bindStruct(this.getBinder(parameter), val); }

  /** Binds an array value to the specified ECSQL parameter.
   * @param parameter Index (1-based) or name of the parameter
   * @param val Array value. The array value is an array of values of the supported types
   */
  public bindArray(parameter: number | string, val: any[]): void { ECSqlBindingHelper.bindArray(this.getBinder(parameter), val); }

  /** Bind values to all parameters in the statement.
   * @param values The values to bind to the parameters.
   * Pass an *array* of values if the parameters are *positional*.
   * Pass an *object of the values keyed on the parameter name* for *named parameters*.
   * The values in either the array or object must match the respective types of the parameter.
   * The section "[iModelJs Types used in ECSQL Parameter Bindings]($docs/learning/ECSQLParameterTypes)" describes the
   * iModelJs types to be used for the different ECSQL parameter types.
   */
  public bindValues(values: any[] | object): void {
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i++) {
        const paramIndex: number = i + 1;
        const paramValue: any = values[i];
        if (paramValue === undefined || paramValue === null)
          continue;

        ECSqlBindingHelper.bindValue(this.getBinder(paramIndex), paramValue);
      }
      return;
    }

    for (const entry of Object.entries(values)) {
      const paramName: string = entry[0];
      const paramValue: any = entry[1];
      if (paramValue === undefined || paramValue === null)
        continue;

      ECSqlBindingHelper.bindValue(this.getBinder(paramName), paramValue);
    }
  }

  private getBinder(param: string | number): NativeECSqlBinder { return this._stmt!.getBinder(param); }

  /** Clear any bindings that were previously set on this statement.
   * @throws [IModelError]($imodeljs-common.IModelError) in case of errors
   */
  public clearBindings(): void {
    const stat: DbResult = this._stmt!.clearBindings();
    if (stat !== DbResult.BE_SQLITE_OK)
      throw new IModelError(stat);
  }

  /** Step this statement to the next row.
   * @returns For **ECSQL SELECT** statements the method returns
   *  * [DbResult.BE_SQLITE_ROW]($bentleyjs-core.DbResult.BE_SQLITE_ROW) if the statement now points successfully to the next row.
   *  * [DbResult.BE_SQLITE_DONE]($bentleyjs-core.DbResult.BE_SQLITE_DONE) if the statement has no more rows.
   *  * Error status in case of errors.
   *  For **ECSQL INSERT, UPDATE, DELETE** statements the method returns
   *  * [DbResult.BE_SQLITE_DONE]($bentleyjs-core.DbResult.BE_SQLITE_DONE) if the statement has been executed successfully.
   *  * Error status in case of errors.
   *  >  Insert statements can be used with ECDb only, not with IModelDb.
   */
  public step(): DbResult { return this._stmt!.step(); }

  /** Step this INSERT statement and returns status and the ECInstanceId of the newly
   * created instance.
   *
   * > Insert statements can be used with ECDb only, not with IModelDb.
   *
   * @returns Returns the generated ECInstanceId in case of success and the status of the step
   * call. In case of error, the respective error code is returned.
   */
  public stepForInsert(): ECSqlInsertResult {
    const r: { status: DbResult, id: string } = this._stmt!.stepForInsert();
    if (r.status === DbResult.BE_SQLITE_DONE)
      return new ECSqlInsertResult(r.status, new Id64(r.id));

    return new ECSqlInsertResult(r.status);
  }

  /** Get the query result's column count (only for ECSQL SELECT statements). */
  public getColumnCount(): number { return this._stmt!.getColumnCount(); }

  /** Get the current row.
   * The returned row is formatted as JavaScript object where every SELECT clause item becomes a property in the JavaScript object.
   *
   * See [ECSQL row format]($docs/learning/ECSQLRowFormat) for details about the format of the returned row.
   */
  public getRow(): any {
    const colCount: number = this.getColumnCount();
    const row: object = {};
    const duplicatePropNames = new Map<string, number>();
    for (let i = 0; i < colCount; i++) {
      const ecsqlValue = this.getValue(i);
      if (!ecsqlValue.isNull()) {
        const propName: string = ECSqlValueHelper.determineResultRowPropertyName(duplicatePropNames, ecsqlValue);
        const val: any = ecsqlValue.value;
        Object.defineProperty(row, propName, { enumerable: true, configurable: true, writable: true, value: val });
      }
    }
    return row;
  }

  /** Calls step when called as an iterator.
   *  Each iteration returns an [ECSQL row format]($docs/learning/ECSQLRowFormat)
   */
  public next(): IteratorResult<any> {
    if (DbResult.BE_SQLITE_ROW === this.step()) {
      return {
        done: false,
        value: this.getRow(),
      };
    } else {
      return {
        done: true,
        value: undefined,
      };
    }
  }

  /** The iterator that will step through the results of this statement. */
  public [Symbol.iterator](): IterableIterator<any> { return this; }

  /** Get the value for the column at the given index in the query result.
   * @param columnIx Index of ECSQL column in query result (0-based)
   */
  public getValue(columnIx: number): ECSqlValue { return new ECSqlValue(this._stmt!.getValue(columnIx)); }
}

/** Represents the value of a specific ECSQL column in the current
 * row of the result set of an ECSQL SELECT statement.
 *
 * See [ECSqlStatement]($imodeljs-backend.ECSqlStatement), [ECSqlStatement.getValue]($imodeljs-backend.ECSqlStatement.getValue)
 */
export class ECSqlValue {
  private _val: NativeECSqlValue;

  public constructor(val: NativeECSqlValue) { this._val = val; }

  /** Get information about the ECSQL SELECT result's column this value refers to. */
  public get columnInfo(): ECSqlColumnInfo { return this._val.getColumnInfo() as ECSqlColumnInfo; }

  /** Get the value of this ECSQL value */
  public get value(): any { return ECSqlValueHelper.getValue(this); }

  /** Indicates whether the value is NULL or not. */
  public isNull(): boolean { return this._val.isNull(); }
  /** Get the value as BLOB (formatted as Base64 string) */
  public getBlob(): ArrayBuffer { return this._val.getBlob(); }
  /** Get the value as a boolean value */
  public getBoolean(): boolean { return this._val.getBoolean(); }
  /** Get the value as a DateTime value (formatted as ISO8601 string) */
  public getDateTime(): string { return this._val.getDateTime(); }
  /** Get the value as a double value */
  public getDouble(): number { return this._val.getDouble(); }
  /** Get the value as a IGeometry value (as ECJSON IGeometry) */
  public getGeometry(): any { return JSON.parse(this._val.getGeometry()); }
  /** Get the value as a GUID (formatted as GUID string).
   *  See [Guid]($bentleyjs-core.Guid)
   */
  public getGuid(): string { return this._val.getGuid(); }
  /** Get the value as a Id (formatted as hexadecimal string). */
  public getId(): string { return this._val.getId(); }
  /** Get the ClassId value formatted as fully qualified class name. */
  public getClassNameForClassId(): string { return this._val.getClassNameForClassId(); }
  /** Get the value as a integer value */
  public getInteger(): number { return this._val.getInt64(); }
  /** Get the value as a string value */
  public getString(): string { return this._val.getString(); }
  /** Get the value as [XAndY]($geometry-core.XAndY) */
  public getXAndY(): XAndY { return this._val.getPoint2d(); }
  /** Get the value as [XYAndZ]($geometry-core.XYAndZ) */
  public getXYAndZ(): XYAndZ { return this._val.getPoint3d(); }
  /** Get the value as [NavigationValue]($imodeljs-common.NavigationValue) */
  public getNavigation(): NavigationValue { return this._val.getNavigation(); }

  /** Get an iterator for iterating the struct members of this struct value. */
  public getStructIterator(): ECSqlValueIterator { return new ECSqlValueIterator(this._val.getStructIterator()); }

  /** Get this struct value's content as object literal */
  public getStruct(): any { return ECSqlValueHelper.getStruct(this); }

  /** Get an iterator for iterating the array elements of this array value. */
  public getArrayIterator(): ECSqlValueIterator { return new ECSqlValueIterator(this._val.getArrayIterator()); }

  /** Get this array value as JS array */
  public getArray(): any[] { return ECSqlValueHelper.getArray(this); }
}

/** The ECSqlValueIterator is used to iterate the members of a struct ECSqlValue or
 *  the elements of an array ECSqlValue.
 *  See [ECSqlValue.getStructIterator]($imodeljs-backend.ECSqlValue.getStructIterator) or
 *  [ECSqlValue.getArrayIterator]($imodeljs-backend.ECSqlValue.getArrayIterator).
 */
export class ECSqlValueIterator implements IterableIterator<ECSqlValue> {
  private _it: NativeECSqlValueIterator;

  public constructor(it: NativeECSqlValueIterator) { this._it = it; }

  public next(): IteratorResult<ECSqlValue> {
    if (this._it.moveNext())
      return { done: false, value: new ECSqlValue(this._it.getCurrent()) };

    // seems issue in IteratorResult definition if strict type checking is on. Requires
    // me to set value in the result but it cannot be undefined. Workaround cast to any
    return { done: true } as any as IteratorResult<ECSqlValue>;
  }

  public [Symbol.iterator](): IterableIterator<ECSqlValue> { return this; }
}

/** Represents the value of a specific ECSQL column in the current
 * row of the result set of an ECSQL SELECT statement.
 *
 * See [ECSqlStatement]($imodeljs-backend.ECSqlStatement), [ECSqlStatement.getValue]($imodeljs-backend.ECSqlStatement.getValue)
 */
export interface ECSqlColumnInfo {
  /** Gets the data type of the column.
   */
  getType(): ECSqlValueType;

  /** Gets the name of the property backing the column.
   * <em>note:</em> If this column is backed by a generated property, i.e. it represents ECSQL expression,
   * the access string consists of the name of the generated property.
   */
  getPropertyName(): string;

  /** Gets the full access string to the corresponding ECSqlValue starting from the root class.
   * <em>note:</em> If this column is backed by a generated property, i.e. it represents ECSQL expression,
   * the access string consists of the ECSQL expression.
   */
  getAccessString(): string;

  /** Indicates whether the column refers to a system property (e.g. id, className) backing the column. */
  isSystemProperty(): boolean;

  /** Indicates whether the column is backed by a generated property or not. For SELECT clause items that are expressions other
   * than simply a reference to an ECProperty, a property is generated containing the expression name.
   */
  isGeneratedProperty(): boolean;

  /** Gets the table space in which this root class is persisted.
   * <em>note:</em> for classes in the primary file the table space is MAIN. For classes in attached
   * files, the table space is the name by which the file was attached. For generated properties the table space is empty.
   */
  getRootClassTableSpace(): string;

  /** Gets the fully qualified name of the ECClass of the top-level ECProperty backing this column. */
  getRootClassName(): string;

  /** Gets the class alias of the root class to which the column refers to.
   * @returns Returns the alias of root class the column refers to or an empty string if no class alias was specified in the select clause.
   */
  getRootClassAlias(): string;
}

class ECSqlBindingHelper {

  /** Binds the specified value to the specified binder
   * @param binder Parameter Binder to bind to
   * @param val Value to be bound. (See [iModelJs Types used in ECSQL Parameter Bindings]($docs/learning/ECSQLParameterTypes))
   * @throws IModelError in case of errors
   */
  public static bindValue(binder: NativeECSqlBinder, val: any): void {
    // returns undefined if val is no primitive and returns DbResult if it is primitive and a binding call was done
    const primStat: DbResult | undefined = ECSqlBindingHelper.tryBindPrimitiveTypes(binder, val);
    if (primStat !== undefined) {
      if (primStat !== DbResult.BE_SQLITE_OK)
        throw new IModelError(primStat);

      return;
    }

    if (Array.isArray(val)) {
      ECSqlBindingHelper.bindArray(binder, val);
      return;
    }

    if (typeof (val) === "object") {
      ECSqlBindingHelper.bindStruct(binder, val);
      return;
    }

    throw new Error(`Bound value is of an unsupported type: ${val}`);
  }

  /** Binds the specified primitive value to the specified binder
   * @param binder Parameter Binder to bind to
   * @param val Primitive value to be bound. Must be of one of these types:
   *  null | undefined, boolean, number, string, DateTime, Blob, Id64, XY, XYZ, NavigationValue
   * @throws IModelError in case of errors
   */
  public static bindPrimitive(binder: NativeECSqlBinder, val: any): void {
    const stat: DbResult | undefined = ECSqlBindingHelper.tryBindPrimitiveTypes(binder, val);
    if (stat === undefined)
      throw new IModelError(DbResult.BE_SQLITE_ERROR, `Binding value is of an unsupported primitive type: ${val}`);

    if (stat !== DbResult.BE_SQLITE_OK)
      throw new IModelError(stat);
  }

  /** Binds the specified object to the specified struct binder
   * @param binder Struct parameter binder to bind to
   * @param val Value to be bound. Must be an Object with members of the supported types
   * @throws IModelError in case of errors
   */
  public static bindStruct(binder: NativeECSqlBinder, val: object): void {
    if (val === null || val === undefined) {
      const stat: DbResult = binder.bindNull();
      if (stat !== DbResult.BE_SQLITE_OK)
        throw new IModelError(stat);

      return;
    }

    for (const member of Object.entries(val)) {
      const memberName: string = member[0];
      const memberVal: any = member[1];
      ECSqlBindingHelper.bindValue(binder.bindMember(memberName), memberVal);
    }
  }

  /** Binds the specified array to the specified array binder
   * @param binder Array parameter binder to bind to
   * @param val Value to be bound. Must be an Array with elements of the supported types
   * @throws IModelError in case of errors
   */
  public static bindArray(binder: NativeECSqlBinder, val: any[]): void {
    if (val === null || val === undefined) {
      const stat: DbResult = binder.bindNull();
      if (stat !== DbResult.BE_SQLITE_OK)
        throw new IModelError(stat);

      return;
    }

    for (const element of val) {
      ECSqlBindingHelper.bindValue(binder.addArrayElement(), element);
    }
  }

  /** tries to interpret the passed value as known leaf types (primitives and navigation values).
   *  @returns Returns undefined if the value wasn't a primitive. DbResult if it was a primitive and was bound to the binder
   */
  private static tryBindPrimitiveTypes(binder: NativeECSqlBinder, val: any): DbResult | undefined {
    if (val === undefined || val === null)
      return binder.bindNull();

    if (typeof (val) === "number")
      return Number.isInteger(val) ? binder.bindInteger(val) : binder.bindDouble(val);

    if (typeof (val) === "boolean")
      return binder.bindBoolean(val);

    if (typeof (val) === "string")
      return binder.bindString(val);

    if (ECSqlTypeHelper.isBlob(val))
      return binder.bindBlob(val);

    if (ECSqlTypeHelper.isDateTime(val))
      return binder.bindDateTime(val.value);

    if (ECSqlTypeHelper.isIdString(val) || val instanceof Id64)
      return binder.bindId(ECSqlTypeHelper.toIdString(val));

    if (ECSqlTypeHelper.isGuidString(val) || val instanceof Guid)
      return binder.bindGuid(ECSqlTypeHelper.toGuidString(val));

    if (ECSqlTypeHelper.isXYAndZ(val))
      return binder.bindPoint3d(val.x, val.y, val.z);

    if (ECSqlTypeHelper.isXAndY(val))
      return binder.bindPoint2d(val.x, val.y);

    if (ECSqlTypeHelper.isNavigationBindingValue(val))
      return binder.bindNavigation(ECSqlTypeHelper.toIdString(val.id), val.relClassName, val.relClassTableSpace);

    return undefined;
  }
}

class ECSqlValueHelper {
  public static getValue(ecsqlValue: ECSqlValue): any {
    if (ecsqlValue.isNull())
      return undefined;

    const dataType: ECSqlValueType = ecsqlValue.columnInfo.getType();
    switch (dataType) {
      case ECSqlValueType.Struct:
        return ECSqlValueHelper.getStruct(ecsqlValue);

      case ECSqlValueType.Navigation:
        return ecsqlValue.getNavigation();

      case ECSqlValueType.PrimitiveArray:
      case ECSqlValueType.StructArray:
        return ECSqlValueHelper.getArray(ecsqlValue);

      default:
        return ECSqlValueHelper.getPrimitiveValue(ecsqlValue);
    }
  }

  public static determineResultRowPropertyName(duplicatePropNames: Map<string, number>, ecsqlValue: ECSqlValue): string {
    const colInfo: ECSqlColumnInfo = ecsqlValue.columnInfo;
    let propName: string;

    const colAccessString: string = colInfo.getAccessString();

    // only top-level system properties need to be treated separately. For other system properties
    // we need the full access string to be returned
    if (colInfo.isSystemProperty()) {
      if (colAccessString === "ECInstanceId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.ECInstanceId);
      else if (colAccessString === "ECClassId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.ECClassId);
      else if (colAccessString === "SourceECInstanceId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.SourceECInstanceId);
      else if (colAccessString === "TargetECInstanceId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.TargetECInstanceId);
      else if (colAccessString === "SourceECClassId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.SourceECClassId);
      else if (colAccessString === "TargetECClassId")
        propName = ECJsNames.toJsName(ECSqlSystemProperty.TargetECClassId);
      else {
        // now handle nested system props: output them with full access string, but
        // replace the system portion of it
        const accessStringTokens: string[] = colAccessString.split(".");
        const tokenCount: number = accessStringTokens.length;
        const leafToken: string = accessStringTokens[tokenCount - 1];
        propName = ECJsNames.toJsName(accessStringTokens[0] + ".");
        for (let j = 1; j < tokenCount - 1; j++) {
          propName += accessStringTokens[j] + ".";
        }

        if (leafToken === "Id")
          propName += ECJsNames.toJsName(ECSqlSystemProperty.NavigationId);
        else if (leafToken === "RelECClassId")
          propName += ECJsNames.toJsName(ECSqlSystemProperty.NavigationRelClassId);
        else if (leafToken === "X")
          propName += ECJsNames.toJsName(ECSqlSystemProperty.PointX);
        else if (leafToken === "Y")
          propName += ECJsNames.toJsName(ECSqlSystemProperty.PointY);
        else if (leafToken === "Z")
          propName += ECJsNames.toJsName(ECSqlSystemProperty.PointZ);
        else throw new IModelError(BentleyStatus.ERROR, "Unhandled ECSQL system property: " + colInfo.getAccessString());
      }
    } else
      propName = ECJsNames.toJsName(colAccessString);

    // now check duplicates. If there are, append a numeric suffix to the duplicates
    let suffix: number | undefined = duplicatePropNames.get(propName);
    if (suffix === undefined)
      duplicatePropNames.set(propName, 0);
    else {
      suffix++;
      duplicatePropNames.set(propName, suffix);
      propName += "_" + suffix;
    }

    return propName;
  }

  public static getStruct(ecsqlValue: ECSqlValue): any {
    if (ecsqlValue.isNull())
      return undefined;

    const structVal = {};
    const it = ecsqlValue.getStructIterator();
    try {
      for (const memberECSqlVal of it) {
        if (memberECSqlVal.isNull())
          continue;

        const memberName: string = ECJsNames.toJsName(memberECSqlVal.columnInfo.getPropertyName());
        const memberVal = ECSqlValueHelper.getValue(memberECSqlVal);
        Object.defineProperty(structVal, memberName, { enumerable: true, configurable: true, writable: true, value: memberVal });
      }
    } finally {
    }

    return structVal;
  }

  public static getArray(ecsqlValue: ECSqlValue): any[] {
    const arrayVal: any[] = [];
    const it = ecsqlValue.getArrayIterator();
    try {
      for (const elementECSqlVal of it) {
        const memberVal = ECSqlValueHelper.getValue(elementECSqlVal);
        arrayVal.push(memberVal);
      }
    } finally {
    }
    return arrayVal;
  }

  private static getPrimitiveValue(ecsqlValue: ECSqlValue): any {
    if (ecsqlValue.isNull())
      return undefined;

    const colInfo: ECSqlColumnInfo = ecsqlValue.columnInfo;
    switch (colInfo.getType()) {
      case ECSqlValueType.Blob:
        return ecsqlValue.getBlob();
      case ECSqlValueType.Boolean:
        return ecsqlValue.getBoolean();
      case ECSqlValueType.DateTime:
        return ecsqlValue.getDateTime();
      case ECSqlValueType.Double:
        return ecsqlValue.getDouble();
      case ECSqlValueType.Geometry:
        return ecsqlValue.getGeometry();
      case ECSqlValueType.Guid:
        return ecsqlValue.getGuid();
      case ECSqlValueType.Id: {
        if (colInfo.isSystemProperty() && colInfo.getPropertyName().endsWith("ECClassId"))
          return ecsqlValue.getClassNameForClassId();

        return ecsqlValue.getId();
      }
      // JS doesn't tell between int32 and larger ints, so retrieve them with the getInt64 method
      case ECSqlValueType.Int:
      case ECSqlValueType.Int64:
        return ecsqlValue.getInteger();
      case ECSqlValueType.Point2d:
        return ecsqlValue.getXAndY();
      case ECSqlValueType.Point3d:
        return ecsqlValue.getXYAndZ();
      case ECSqlValueType.String:
        return ecsqlValue.getString();
      default:
        throw new IModelError(DbResult.BE_SQLITE_ERROR, `Unsupported type ${ecsqlValue.columnInfo.getType()} of the ECSQL Value`);
    }
  }

  public static queryClassName(ecdb: ECDb, classId: Id64, tableSpace?: string): string {
    if (tableSpace === undefined)
      tableSpace = "main";

    return ecdb.withPreparedStatement("SELECT s.Name schemaName, c.Name className FROM [" + tableSpace
      + "].meta.ECSchemaDef s, JOIN [" + tableSpace + "].meta.ECClassDef c ON s.ECInstanceId=c.SchemaId WHERE c.ECInstanceId=?",
      (stmt: ECSqlStatement) => {
        stmt.bindId(1, classId);
        if (stmt.step() !== DbResult.BE_SQLITE_ROW)
          throw new IModelError(DbResult.BE_SQLITE_ERROR, "No class found with ECClassId " + classId.value + " in table space " + tableSpace + ".");

        const row: any = stmt.getRow();
        return row.schemaName + "." + row.className;
      });
  }
}

class ECSqlTypeHelper {
  public static isBlob(val: any): val is ArrayBuffer { return val instanceof ArrayBuffer; }
  public static isDateTime(val: any): val is ECSqlTypedString { return val.type !== undefined && val.type === ECSqlStringType.DateTime && typeof (val.value) === "string"; }
  public static isGuidString(val: any): val is ECSqlTypedString {
    return (val.type !== undefined && val.type === ECSqlStringType.Guid && val.value !== undefined && typeof (val.value) === "string");
  }

  public static toGuidString(val: ECSqlTypedString | GuidProps): string {
    if (ECSqlTypeHelper.isGuidString(val))
      return val.value;

    if (typeof (val) === "string")
      return val;

    return val.value;
  }

  public static isIdString(val: any): val is ECSqlTypedString {
    return (val.type !== undefined && val.type === ECSqlStringType.Id && val.value !== undefined && typeof (val.value) === "string");
  }

  public static toIdString(val: ECSqlTypedString | Id64Props): string {
    if (ECSqlTypeHelper.isIdString(val))
      return val.value;

    if (typeof (val) === "string")
      return val;

    return val.value;
  }

  public static isXAndY(val: any): val is XAndY { return XYZ.isXAndY(val); }
  public static isXYAndZ(val: any): val is XYAndZ { return XYZ.isXYAndZ(val); }

  public static isNavigationBindingValue(val: any): val is NavigationBindingValue { return val.id !== undefined && (ECSqlTypeHelper.isIdString(val.id) || typeof (val.id) === "string" || val.id instanceof Id64); }
}
export class CachedECSqlStatement {
  public statement: ECSqlStatement;
  public useCount: number;

  public constructor(stmt: ECSqlStatement) {
    this.statement = stmt;
    this.useCount = 1;
  }
}

export class ECSqlStatementCache {
  private readonly statements: Map<string, CachedECSqlStatement> = new Map<string, CachedECSqlStatement>();
  public readonly maxCount: number;

  constructor(maxCount: number = 20) {
    this.maxCount = maxCount;
  }

  public add(str: string, stmt: ECSqlStatement): void {
    const existing = this.statements.get(str);
    if (existing !== undefined) {
      throw new Error("you should only add a statement if all existing copies of it are in use.");
    }
    const cs = new CachedECSqlStatement(stmt);
    cs.statement.setIsShared(true);
    this.statements.set(str, cs);
  }

  public getCount(): number { return this.statements.size; }

  public find(str: string): CachedECSqlStatement | undefined {
    return this.statements.get(str);
  }

  public release(stmt: ECSqlStatement): void {
    for (const cs of this.statements) {
      const css = cs[1];
      if (css.statement === stmt) {
        if (css.useCount > 0) {
          css.useCount--;
          if (css.useCount === 0) {
            css.statement.reset();
            css.statement.clearBindings();
          }
        } else {
          throw new Error("double-release of cached statement");
        }
        // leave the statement in the cache, even if its use count goes to zero. See removeUnusedStatements and clearOnClose.
        // *** TODO: we should remove it if it is a duplicate of another unused statement in the cache. The trouble is that we don't have the ecsql for the statement,
        //           so we can't check for other equivalent statements.
        break;
      }
    }
  }

  public removeUnusedStatementsIfNecessary(): void {
    if (this.getCount() <= this.maxCount)
      return;

    const keysToRemove = [];
    for (const cs of this.statements) {
      const css = cs[1];
      if (css.useCount === 0) {
        css.statement.setIsShared(false);
        css.statement.dispose();
        keysToRemove.push(cs[0]);
        if (keysToRemove.length >= this.maxCount)
          break;
      }
    }
    for (const k of keysToRemove) {
      this.statements.delete(k);
    }
  }

  public clear() {
    for (const cs of this.statements) {
      const stmt = cs[1].statement;
      if (stmt !== undefined) {
        stmt.setIsShared(false);
        stmt.dispose();
      }
    }
    this.statements.clear();
  }
}
