"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS({
  "../../node_modules/ajv/dist/compile/codegen/code.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.regexpCode = exports2.getEsmExportName = exports2.getProperty = exports2.safeStringify = exports2.stringify = exports2.strConcat = exports2.addCodeArg = exports2.str = exports2._ = exports2.nil = exports2._Code = exports2.Name = exports2.IDENTIFIER = exports2._CodeOrName = void 0;
    var _CodeOrName = class {
    };
    exports2._CodeOrName = _CodeOrName;
    exports2.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
    var Name = class extends _CodeOrName {
      constructor(s) {
        super();
        if (!exports2.IDENTIFIER.test(s))
          throw new Error("CodeGen: name must be a valid identifier");
        this.str = s;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        return false;
      }
      get names() {
        return { [this.str]: 1 };
      }
    };
    exports2.Name = Name;
    var _Code = class extends _CodeOrName {
      constructor(code) {
        super();
        this._items = typeof code === "string" ? [code] : code;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        if (this._items.length > 1)
          return false;
        const item = this._items[0];
        return item === "" || item === '""';
      }
      get str() {
        var _a;
        return (_a = this._str) !== null && _a !== void 0 ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
      }
      get names() {
        var _a;
        return (_a = this._names) !== null && _a !== void 0 ? _a : this._names = this._items.reduce((names, c) => {
          if (c instanceof Name)
            names[c.str] = (names[c.str] || 0) + 1;
          return names;
        }, {});
      }
    };
    exports2._Code = _Code;
    exports2.nil = new _Code("");
    function _(strs, ...args) {
      const code = [strs[0]];
      let i = 0;
      while (i < args.length) {
        addCodeArg(code, args[i]);
        code.push(strs[++i]);
      }
      return new _Code(code);
    }
    exports2._ = _;
    var plus = new _Code("+");
    function str(strs, ...args) {
      const expr = [safeStringify(strs[0])];
      let i = 0;
      while (i < args.length) {
        expr.push(plus);
        addCodeArg(expr, args[i]);
        expr.push(plus, safeStringify(strs[++i]));
      }
      optimize(expr);
      return new _Code(expr);
    }
    exports2.str = str;
    function addCodeArg(code, arg) {
      if (arg instanceof _Code)
        code.push(...arg._items);
      else if (arg instanceof Name)
        code.push(arg);
      else
        code.push(interpolate(arg));
    }
    exports2.addCodeArg = addCodeArg;
    function optimize(expr) {
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === plus) {
          const res = mergeExprItems(expr[i - 1], expr[i + 1]);
          if (res !== void 0) {
            expr.splice(i - 1, 3, res);
            continue;
          }
          expr[i++] = "+";
        }
        i++;
      }
    }
    function mergeExprItems(a, b) {
      if (b === '""')
        return a;
      if (a === '""')
        return b;
      if (typeof a == "string") {
        if (b instanceof Name || a[a.length - 1] !== '"')
          return;
        if (typeof b != "string")
          return `${a.slice(0, -1)}${b}"`;
        if (b[0] === '"')
          return a.slice(0, -1) + b.slice(1);
        return;
      }
      if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
        return `"${a}${b.slice(1)}`;
      return;
    }
    function strConcat(c1, c2) {
      return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
    }
    exports2.strConcat = strConcat;
    function interpolate(x) {
      return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
    }
    function stringify(x) {
      return new _Code(safeStringify(x));
    }
    exports2.stringify = stringify;
    function safeStringify(x) {
      return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    exports2.safeStringify = safeStringify;
    function getProperty(key) {
      return typeof key == "string" && exports2.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
    }
    exports2.getProperty = getProperty;
    function getEsmExportName(key) {
      if (typeof key == "string" && exports2.IDENTIFIER.test(key)) {
        return new _Code(`${key}`);
      }
      throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
    }
    exports2.getEsmExportName = getEsmExportName;
    function regexpCode(rx) {
      return new _Code(rx.toString());
    }
    exports2.regexpCode = regexpCode;
  }
});

// ../../node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS({
  "../../node_modules/ajv/dist/compile/codegen/scope.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ValueScope = exports2.ValueScopeName = exports2.Scope = exports2.varKinds = exports2.UsedValueState = void 0;
    var code_1 = require_code();
    var ValueError = class extends Error {
      constructor(name) {
        super(`CodeGen: "code" for ${name} not defined`);
        this.value = name.value;
      }
    };
    var UsedValueState;
    (function(UsedValueState2) {
      UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
      UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
    })(UsedValueState || (exports2.UsedValueState = UsedValueState = {}));
    exports2.varKinds = {
      const: new code_1.Name("const"),
      let: new code_1.Name("let"),
      var: new code_1.Name("var")
    };
    var Scope = class {
      constructor({ prefixes, parent } = {}) {
        this._names = {};
        this._prefixes = prefixes;
        this._parent = parent;
      }
      toName(nameOrPrefix) {
        return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
      }
      name(prefix) {
        return new code_1.Name(this._newName(prefix));
      }
      _newName(prefix) {
        const ng = this._names[prefix] || this._nameGroup(prefix);
        return `${prefix}${ng.index++}`;
      }
      _nameGroup(prefix) {
        var _a, _b;
        if (((_b = (_a = this._parent) === null || _a === void 0 ? void 0 : _a._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
          throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
        }
        return this._names[prefix] = { prefix, index: 0 };
      }
    };
    exports2.Scope = Scope;
    var ValueScopeName = class extends code_1.Name {
      constructor(prefix, nameStr) {
        super(nameStr);
        this.prefix = prefix;
      }
      setValue(value, { property, itemIndex }) {
        this.value = value;
        this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
      }
    };
    exports2.ValueScopeName = ValueScopeName;
    var line = (0, code_1._)`\n`;
    var ValueScope = class extends Scope {
      constructor(opts) {
        super(opts);
        this._values = {};
        this._scope = opts.scope;
        this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
      }
      get() {
        return this._scope;
      }
      name(prefix) {
        return new ValueScopeName(prefix, this._newName(prefix));
      }
      value(nameOrPrefix, value) {
        var _a;
        if (value.ref === void 0)
          throw new Error("CodeGen: ref must be passed in value");
        const name = this.toName(nameOrPrefix);
        const { prefix } = name;
        const valueKey = (_a = value.key) !== null && _a !== void 0 ? _a : value.ref;
        let vs = this._values[prefix];
        if (vs) {
          const _name = vs.get(valueKey);
          if (_name)
            return _name;
        } else {
          vs = this._values[prefix] = /* @__PURE__ */ new Map();
        }
        vs.set(valueKey, name);
        const s = this._scope[prefix] || (this._scope[prefix] = []);
        const itemIndex = s.length;
        s[itemIndex] = value.ref;
        name.setValue(value, { property: prefix, itemIndex });
        return name;
      }
      getValue(prefix, keyOrRef) {
        const vs = this._values[prefix];
        if (!vs)
          return;
        return vs.get(keyOrRef);
      }
      scopeRefs(scopeName, values = this._values) {
        return this._reduceValues(values, (name) => {
          if (name.scopePath === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return (0, code_1._)`${scopeName}${name.scopePath}`;
        });
      }
      scopeCode(values = this._values, usedValues, getCode) {
        return this._reduceValues(values, (name) => {
          if (name.value === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return name.value.code;
        }, usedValues, getCode);
      }
      _reduceValues(values, valueCode, usedValues = {}, getCode) {
        let code = code_1.nil;
        for (const prefix in values) {
          const vs = values[prefix];
          if (!vs)
            continue;
          const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
          vs.forEach((name) => {
            if (nameSet.has(name))
              return;
            nameSet.set(name, UsedValueState.Started);
            let c = valueCode(name);
            if (c) {
              const def = this.opts.es5 ? exports2.varKinds.var : exports2.varKinds.const;
              code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
            } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) {
              code = (0, code_1._)`${code}${c}${this.opts._n}`;
            } else {
              throw new ValueError(name);
            }
            nameSet.set(name, UsedValueState.Completed);
          });
        }
        return code;
      }
    };
    exports2.ValueScope = ValueScope;
  }
});

// ../../node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS({
  "../../node_modules/ajv/dist/compile/codegen/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.or = exports2.and = exports2.not = exports2.CodeGen = exports2.operators = exports2.varKinds = exports2.ValueScopeName = exports2.ValueScope = exports2.Scope = exports2.Name = exports2.regexpCode = exports2.stringify = exports2.getProperty = exports2.nil = exports2.strConcat = exports2.str = exports2._ = void 0;
    var code_1 = require_code();
    var scope_1 = require_scope();
    var code_2 = require_code();
    Object.defineProperty(exports2, "_", { enumerable: true, get: function() {
      return code_2._;
    } });
    Object.defineProperty(exports2, "str", { enumerable: true, get: function() {
      return code_2.str;
    } });
    Object.defineProperty(exports2, "strConcat", { enumerable: true, get: function() {
      return code_2.strConcat;
    } });
    Object.defineProperty(exports2, "nil", { enumerable: true, get: function() {
      return code_2.nil;
    } });
    Object.defineProperty(exports2, "getProperty", { enumerable: true, get: function() {
      return code_2.getProperty;
    } });
    Object.defineProperty(exports2, "stringify", { enumerable: true, get: function() {
      return code_2.stringify;
    } });
    Object.defineProperty(exports2, "regexpCode", { enumerable: true, get: function() {
      return code_2.regexpCode;
    } });
    Object.defineProperty(exports2, "Name", { enumerable: true, get: function() {
      return code_2.Name;
    } });
    var scope_2 = require_scope();
    Object.defineProperty(exports2, "Scope", { enumerable: true, get: function() {
      return scope_2.Scope;
    } });
    Object.defineProperty(exports2, "ValueScope", { enumerable: true, get: function() {
      return scope_2.ValueScope;
    } });
    Object.defineProperty(exports2, "ValueScopeName", { enumerable: true, get: function() {
      return scope_2.ValueScopeName;
    } });
    Object.defineProperty(exports2, "varKinds", { enumerable: true, get: function() {
      return scope_2.varKinds;
    } });
    exports2.operators = {
      GT: new code_1._Code(">"),
      GTE: new code_1._Code(">="),
      LT: new code_1._Code("<"),
      LTE: new code_1._Code("<="),
      EQ: new code_1._Code("==="),
      NEQ: new code_1._Code("!=="),
      NOT: new code_1._Code("!"),
      OR: new code_1._Code("||"),
      AND: new code_1._Code("&&"),
      ADD: new code_1._Code("+")
    };
    var Node = class {
      optimizeNodes() {
        return this;
      }
      optimizeNames(_names, _constants) {
        return this;
      }
    };
    var Def = class extends Node {
      constructor(varKind, name, rhs) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.rhs = rhs;
      }
      render({ es5, _n }) {
        const varKind = es5 ? scope_1.varKinds.var : this.varKind;
        const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
        return `${varKind} ${this.name}${rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (!names[this.name.str])
          return;
        if (this.rhs)
          this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
      }
    };
    var Assign = class extends Node {
      constructor(lhs, rhs, sideEffects) {
        super();
        this.lhs = lhs;
        this.rhs = rhs;
        this.sideEffects = sideEffects;
      }
      render({ _n }) {
        return `${this.lhs} = ${this.rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
          return;
        this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
        return addExprNames(names, this.rhs);
      }
    };
    var AssignOp = class extends Assign {
      constructor(lhs, op, rhs, sideEffects) {
        super(lhs, rhs, sideEffects);
        this.op = op;
      }
      render({ _n }) {
        return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
      }
    };
    var Label = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        return `${this.label}:` + _n;
      }
    };
    var Break = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        const label = this.label ? ` ${this.label}` : "";
        return `break${label};` + _n;
      }
    };
    var Throw = class extends Node {
      constructor(error) {
        super();
        this.error = error;
      }
      render({ _n }) {
        return `throw ${this.error};` + _n;
      }
      get names() {
        return this.error.names;
      }
    };
    var AnyCode = class extends Node {
      constructor(code) {
        super();
        this.code = code;
      }
      render({ _n }) {
        return `${this.code};` + _n;
      }
      optimizeNodes() {
        return `${this.code}` ? this : void 0;
      }
      optimizeNames(names, constants) {
        this.code = optimizeExpr(this.code, names, constants);
        return this;
      }
      get names() {
        return this.code instanceof code_1._CodeOrName ? this.code.names : {};
      }
    };
    var ParentNode = class extends Node {
      constructor(nodes = []) {
        super();
        this.nodes = nodes;
      }
      render(opts) {
        return this.nodes.reduce((code, n) => code + n.render(opts), "");
      }
      optimizeNodes() {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i].optimizeNodes();
          if (Array.isArray(n))
            nodes.splice(i, 1, ...n);
          else if (n)
            nodes[i] = n;
          else
            nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      optimizeNames(names, constants) {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i];
          if (n.optimizeNames(names, constants))
            continue;
          subtractNames(names, n.names);
          nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      get names() {
        return this.nodes.reduce((names, n) => addNames(names, n.names), {});
      }
    };
    var BlockNode = class extends ParentNode {
      render(opts) {
        return "{" + opts._n + super.render(opts) + "}" + opts._n;
      }
    };
    var Root = class extends ParentNode {
    };
    var Else = class extends BlockNode {
    };
    Else.kind = "else";
    var If = class _If extends BlockNode {
      constructor(condition, nodes) {
        super(nodes);
        this.condition = condition;
      }
      render(opts) {
        let code = `if(${this.condition})` + super.render(opts);
        if (this.else)
          code += "else " + this.else.render(opts);
        return code;
      }
      optimizeNodes() {
        super.optimizeNodes();
        const cond = this.condition;
        if (cond === true)
          return this.nodes;
        let e = this.else;
        if (e) {
          const ns = e.optimizeNodes();
          e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
        }
        if (e) {
          if (cond === false)
            return e instanceof _If ? e : e.nodes;
          if (this.nodes.length)
            return this;
          return new _If(not(cond), e instanceof _If ? [e] : e.nodes);
        }
        if (cond === false || !this.nodes.length)
          return void 0;
        return this;
      }
      optimizeNames(names, constants) {
        var _a;
        this.else = (_a = this.else) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        if (!(super.optimizeNames(names, constants) || this.else))
          return;
        this.condition = optimizeExpr(this.condition, names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        addExprNames(names, this.condition);
        if (this.else)
          addNames(names, this.else.names);
        return names;
      }
    };
    If.kind = "if";
    var For = class extends BlockNode {
    };
    For.kind = "for";
    var ForLoop = class extends For {
      constructor(iteration) {
        super();
        this.iteration = iteration;
      }
      render(opts) {
        return `for(${this.iteration})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iteration = optimizeExpr(this.iteration, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iteration.names);
      }
    };
    var ForRange = class extends For {
      constructor(varKind, name, from, to) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.from = from;
        this.to = to;
      }
      render(opts) {
        const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
        const { name, from, to } = this;
        return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
      }
      get names() {
        const names = addExprNames(super.names, this.from);
        return addExprNames(names, this.to);
      }
    };
    var ForIter = class extends For {
      constructor(loop, varKind, name, iterable) {
        super();
        this.loop = loop;
        this.varKind = varKind;
        this.name = name;
        this.iterable = iterable;
      }
      render(opts) {
        return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iterable = optimizeExpr(this.iterable, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iterable.names);
      }
    };
    var Func = class extends BlockNode {
      constructor(name, args, async) {
        super();
        this.name = name;
        this.args = args;
        this.async = async;
      }
      render(opts) {
        const _async = this.async ? "async " : "";
        return `${_async}function ${this.name}(${this.args})` + super.render(opts);
      }
    };
    Func.kind = "func";
    var Return = class extends ParentNode {
      render(opts) {
        return "return " + super.render(opts);
      }
    };
    Return.kind = "return";
    var Try = class extends BlockNode {
      render(opts) {
        let code = "try" + super.render(opts);
        if (this.catch)
          code += this.catch.render(opts);
        if (this.finally)
          code += this.finally.render(opts);
        return code;
      }
      optimizeNodes() {
        var _a, _b;
        super.optimizeNodes();
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNodes();
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNodes();
        return this;
      }
      optimizeNames(names, constants) {
        var _a, _b;
        super.optimizeNames(names, constants);
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNames(names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        if (this.catch)
          addNames(names, this.catch.names);
        if (this.finally)
          addNames(names, this.finally.names);
        return names;
      }
    };
    var Catch = class extends BlockNode {
      constructor(error) {
        super();
        this.error = error;
      }
      render(opts) {
        return `catch(${this.error})` + super.render(opts);
      }
    };
    Catch.kind = "catch";
    var Finally = class extends BlockNode {
      render(opts) {
        return "finally" + super.render(opts);
      }
    };
    Finally.kind = "finally";
    var CodeGen = class {
      constructor(extScope, opts = {}) {
        this._values = {};
        this._blockStarts = [];
        this._constants = {};
        this.opts = { ...opts, _n: opts.lines ? "\n" : "" };
        this._extScope = extScope;
        this._scope = new scope_1.Scope({ parent: extScope });
        this._nodes = [new Root()];
      }
      toString() {
        return this._root.render(this.opts);
      }
      // returns unique name in the internal scope
      name(prefix) {
        return this._scope.name(prefix);
      }
      // reserves unique name in the external scope
      scopeName(prefix) {
        return this._extScope.name(prefix);
      }
      // reserves unique name in the external scope and assigns value to it
      scopeValue(prefixOrName, value) {
        const name = this._extScope.value(prefixOrName, value);
        const vs = this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set());
        vs.add(name);
        return name;
      }
      getScopeValue(prefix, keyOrRef) {
        return this._extScope.getValue(prefix, keyOrRef);
      }
      // return code that assigns values in the external scope to the names that are used internally
      // (same names that were returned by gen.scopeName or gen.scopeValue)
      scopeRefs(scopeName) {
        return this._extScope.scopeRefs(scopeName, this._values);
      }
      scopeCode() {
        return this._extScope.scopeCode(this._values);
      }
      _def(varKind, nameOrPrefix, rhs, constant) {
        const name = this._scope.toName(nameOrPrefix);
        if (rhs !== void 0 && constant)
          this._constants[name.str] = rhs;
        this._leafNode(new Def(varKind, name, rhs));
        return name;
      }
      // `const` declaration (`var` in es5 mode)
      const(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
      }
      // `let` declaration with optional assignment (`var` in es5 mode)
      let(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
      }
      // `var` declaration with optional assignment
      var(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
      }
      // assignment code
      assign(lhs, rhs, sideEffects) {
        return this._leafNode(new Assign(lhs, rhs, sideEffects));
      }
      // `+=` code
      add(lhs, rhs) {
        return this._leafNode(new AssignOp(lhs, exports2.operators.ADD, rhs));
      }
      // appends passed SafeExpr to code or executes Block
      code(c) {
        if (typeof c == "function")
          c();
        else if (c !== code_1.nil)
          this._leafNode(new AnyCode(c));
        return this;
      }
      // returns code for object literal for the passed argument list of key-value pairs
      object(...keyValues) {
        const code = ["{"];
        for (const [key, value] of keyValues) {
          if (code.length > 1)
            code.push(",");
          code.push(key);
          if (key !== value || this.opts.es5) {
            code.push(":");
            (0, code_1.addCodeArg)(code, value);
          }
        }
        code.push("}");
        return new code_1._Code(code);
      }
      // `if` clause (or statement if `thenBody` and, optionally, `elseBody` are passed)
      if(condition, thenBody, elseBody) {
        this._blockNode(new If(condition));
        if (thenBody && elseBody) {
          this.code(thenBody).else().code(elseBody).endIf();
        } else if (thenBody) {
          this.code(thenBody).endIf();
        } else if (elseBody) {
          throw new Error('CodeGen: "else" body without "then" body');
        }
        return this;
      }
      // `else if` clause - invalid without `if` or after `else` clauses
      elseIf(condition) {
        return this._elseNode(new If(condition));
      }
      // `else` clause - only valid after `if` or `else if` clauses
      else() {
        return this._elseNode(new Else());
      }
      // end `if` statement (needed if gen.if was used only with condition)
      endIf() {
        return this._endBlockNode(If, Else);
      }
      _for(node, forBody) {
        this._blockNode(node);
        if (forBody)
          this.code(forBody).endFor();
        return this;
      }
      // a generic `for` clause (or statement if `forBody` is passed)
      for(iteration, forBody) {
        return this._for(new ForLoop(iteration), forBody);
      }
      // `for` statement for a range of values
      forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
      }
      // `for-of` statement (in es5 mode replace with a normal for loop)
      forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
        const name = this._scope.toName(nameOrPrefix);
        if (this.opts.es5) {
          const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
          return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
            this.var(name, (0, code_1._)`${arr}[${i}]`);
            forBody(name);
          });
        }
        return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
      }
      // `for-in` statement.
      // With option `ownProperties` replaced with a `for-of` loop for object keys
      forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
        if (this.opts.ownProperties) {
          return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
        }
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
      }
      // end `for` loop
      endFor() {
        return this._endBlockNode(For);
      }
      // `label` statement
      label(label) {
        return this._leafNode(new Label(label));
      }
      // `break` statement
      break(label) {
        return this._leafNode(new Break(label));
      }
      // `return` statement
      return(value) {
        const node = new Return();
        this._blockNode(node);
        this.code(value);
        if (node.nodes.length !== 1)
          throw new Error('CodeGen: "return" should have one node');
        return this._endBlockNode(Return);
      }
      // `try` statement
      try(tryBody, catchCode, finallyCode) {
        if (!catchCode && !finallyCode)
          throw new Error('CodeGen: "try" without "catch" and "finally"');
        const node = new Try();
        this._blockNode(node);
        this.code(tryBody);
        if (catchCode) {
          const error = this.name("e");
          this._currNode = node.catch = new Catch(error);
          catchCode(error);
        }
        if (finallyCode) {
          this._currNode = node.finally = new Finally();
          this.code(finallyCode);
        }
        return this._endBlockNode(Catch, Finally);
      }
      // `throw` statement
      throw(error) {
        return this._leafNode(new Throw(error));
      }
      // start self-balancing block
      block(body, nodeCount) {
        this._blockStarts.push(this._nodes.length);
        if (body)
          this.code(body).endBlock(nodeCount);
        return this;
      }
      // end the current self-balancing block
      endBlock(nodeCount) {
        const len = this._blockStarts.pop();
        if (len === void 0)
          throw new Error("CodeGen: not in self-balancing block");
        const toClose = this._nodes.length - len;
        if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) {
          throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
        }
        this._nodes.length = len;
        return this;
      }
      // `function` heading (or definition if funcBody is passed)
      func(name, args = code_1.nil, async, funcBody) {
        this._blockNode(new Func(name, args, async));
        if (funcBody)
          this.code(funcBody).endFunc();
        return this;
      }
      // end function definition
      endFunc() {
        return this._endBlockNode(Func);
      }
      optimize(n = 1) {
        while (n-- > 0) {
          this._root.optimizeNodes();
          this._root.optimizeNames(this._root.names, this._constants);
        }
      }
      _leafNode(node) {
        this._currNode.nodes.push(node);
        return this;
      }
      _blockNode(node) {
        this._currNode.nodes.push(node);
        this._nodes.push(node);
      }
      _endBlockNode(N1, N2) {
        const n = this._currNode;
        if (n instanceof N1 || N2 && n instanceof N2) {
          this._nodes.pop();
          return this;
        }
        throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
      }
      _elseNode(node) {
        const n = this._currNode;
        if (!(n instanceof If)) {
          throw new Error('CodeGen: "else" without "if"');
        }
        this._currNode = n.else = node;
        return this;
      }
      get _root() {
        return this._nodes[0];
      }
      get _currNode() {
        const ns = this._nodes;
        return ns[ns.length - 1];
      }
      set _currNode(node) {
        const ns = this._nodes;
        ns[ns.length - 1] = node;
      }
    };
    exports2.CodeGen = CodeGen;
    function addNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) + (from[n] || 0);
      return names;
    }
    function addExprNames(names, from) {
      return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
    }
    function optimizeExpr(expr, names, constants) {
      if (expr instanceof code_1.Name)
        return replaceName(expr);
      if (!canOptimize(expr))
        return expr;
      return new code_1._Code(expr._items.reduce((items, c) => {
        if (c instanceof code_1.Name)
          c = replaceName(c);
        if (c instanceof code_1._Code)
          items.push(...c._items);
        else
          items.push(c);
        return items;
      }, []));
      function replaceName(n) {
        const c = constants[n.str];
        if (c === void 0 || names[n.str] !== 1)
          return n;
        delete names[n.str];
        return c;
      }
      function canOptimize(e) {
        return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
      }
    }
    function subtractNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) - (from[n] || 0);
    }
    function not(x) {
      return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
    }
    exports2.not = not;
    var andCode = mappend(exports2.operators.AND);
    function and(...args) {
      return args.reduce(andCode);
    }
    exports2.and = and;
    var orCode = mappend(exports2.operators.OR);
    function or(...args) {
      return args.reduce(orCode);
    }
    exports2.or = or;
    function mappend(op) {
      return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
    }
    function par(x) {
      return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
    }
  }
});

// ../../node_modules/ajv/dist/compile/util.js
var require_util = __commonJS({
  "../../node_modules/ajv/dist/compile/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.checkStrictMode = exports2.getErrorPath = exports2.Type = exports2.useFunc = exports2.setEvaluated = exports2.evaluatedPropsToName = exports2.mergeEvaluated = exports2.eachItem = exports2.unescapeJsonPointer = exports2.escapeJsonPointer = exports2.escapeFragment = exports2.unescapeFragment = exports2.schemaRefOrVal = exports2.schemaHasRulesButRef = exports2.schemaHasRules = exports2.checkUnknownRules = exports2.alwaysValidSchema = exports2.toHash = void 0;
    var codegen_1 = require_codegen();
    var code_1 = require_code();
    function toHash(arr) {
      const hash = {};
      for (const item of arr)
        hash[item] = true;
      return hash;
    }
    exports2.toHash = toHash;
    function alwaysValidSchema(it, schema) {
      if (typeof schema == "boolean")
        return schema;
      if (Object.keys(schema).length === 0)
        return true;
      checkUnknownRules(it, schema);
      return !schemaHasRules(schema, it.self.RULES.all);
    }
    exports2.alwaysValidSchema = alwaysValidSchema;
    function checkUnknownRules(it, schema = it.schema) {
      const { opts, self } = it;
      if (!opts.strictSchema)
        return;
      if (typeof schema === "boolean")
        return;
      const rules = self.RULES.keywords;
      for (const key in schema) {
        if (!rules[key])
          checkStrictMode(it, `unknown keyword: "${key}"`);
      }
    }
    exports2.checkUnknownRules = checkUnknownRules;
    function schemaHasRules(schema, rules) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (rules[key])
          return true;
      return false;
    }
    exports2.schemaHasRules = schemaHasRules;
    function schemaHasRulesButRef(schema, RULES) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (key !== "$ref" && RULES.all[key])
          return true;
      return false;
    }
    exports2.schemaHasRulesButRef = schemaHasRulesButRef;
    function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
      if (!$data) {
        if (typeof schema == "number" || typeof schema == "boolean")
          return schema;
        if (typeof schema == "string")
          return (0, codegen_1._)`${schema}`;
      }
      return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
    }
    exports2.schemaRefOrVal = schemaRefOrVal;
    function unescapeFragment(str) {
      return unescapeJsonPointer(decodeURIComponent(str));
    }
    exports2.unescapeFragment = unescapeFragment;
    function escapeFragment(str) {
      return encodeURIComponent(escapeJsonPointer(str));
    }
    exports2.escapeFragment = escapeFragment;
    function escapeJsonPointer(str) {
      if (typeof str == "number")
        return `${str}`;
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    exports2.escapeJsonPointer = escapeJsonPointer;
    function unescapeJsonPointer(str) {
      return str.replace(/~1/g, "/").replace(/~0/g, "~");
    }
    exports2.unescapeJsonPointer = unescapeJsonPointer;
    function eachItem(xs, f) {
      if (Array.isArray(xs)) {
        for (const x of xs)
          f(x);
      } else {
        f(xs);
      }
    }
    exports2.eachItem = eachItem;
    function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
      return (gen, from, to, toName) => {
        const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
        return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
      };
    }
    exports2.mergeEvaluated = {
      props: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
          gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
        }),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
          if (from === true) {
            gen.assign(to, true);
          } else {
            gen.assign(to, (0, codegen_1._)`${to} || {}`);
            setEvaluated(gen, to, from);
          }
        }),
        mergeValues: (from, to) => from === true ? true : { ...from, ...to },
        resultToName: evaluatedPropsToName
      }),
      items: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
        mergeValues: (from, to) => from === true ? true : Math.max(from, to),
        resultToName: (gen, items) => gen.var("items", items)
      })
    };
    function evaluatedPropsToName(gen, ps) {
      if (ps === true)
        return gen.var("props", true);
      const props = gen.var("props", (0, codegen_1._)`{}`);
      if (ps !== void 0)
        setEvaluated(gen, props, ps);
      return props;
    }
    exports2.evaluatedPropsToName = evaluatedPropsToName;
    function setEvaluated(gen, props, ps) {
      Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
    }
    exports2.setEvaluated = setEvaluated;
    var snippets = {};
    function useFunc(gen, f) {
      return gen.scopeValue("func", {
        ref: f,
        code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
      });
    }
    exports2.useFunc = useFunc;
    var Type;
    (function(Type2) {
      Type2[Type2["Num"] = 0] = "Num";
      Type2[Type2["Str"] = 1] = "Str";
    })(Type || (exports2.Type = Type = {}));
    function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
      if (dataProp instanceof codegen_1.Name) {
        const isNumber = dataPropType === Type.Num;
        return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
      }
      return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
    }
    exports2.getErrorPath = getErrorPath;
    function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
      if (!mode)
        return;
      msg = `strict mode: ${msg}`;
      if (mode === true)
        throw new Error(msg);
      it.self.logger.warn(msg);
    }
    exports2.checkStrictMode = checkStrictMode;
  }
});

// ../../node_modules/ajv/dist/compile/names.js
var require_names = __commonJS({
  "../../node_modules/ajv/dist/compile/names.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var names = {
      // validation function arguments
      data: new codegen_1.Name("data"),
      // data passed to validation function
      // args passed from referencing schema
      valCxt: new codegen_1.Name("valCxt"),
      // validation/data context - should not be used directly, it is destructured to the names below
      instancePath: new codegen_1.Name("instancePath"),
      parentData: new codegen_1.Name("parentData"),
      parentDataProperty: new codegen_1.Name("parentDataProperty"),
      rootData: new codegen_1.Name("rootData"),
      // root data - same as the data passed to the first/top validation function
      dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
      // used to support recursiveRef and dynamicRef
      // function scoped variables
      vErrors: new codegen_1.Name("vErrors"),
      // null or array of validation errors
      errors: new codegen_1.Name("errors"),
      // counter of validation errors
      this: new codegen_1.Name("this"),
      // "globals"
      self: new codegen_1.Name("self"),
      scope: new codegen_1.Name("scope"),
      // JTD serialize/parse name for JSON string and position
      json: new codegen_1.Name("json"),
      jsonPos: new codegen_1.Name("jsonPos"),
      jsonLen: new codegen_1.Name("jsonLen"),
      jsonPart: new codegen_1.Name("jsonPart")
    };
    exports2.default = names;
  }
});

// ../../node_modules/ajv/dist/compile/errors.js
var require_errors = __commonJS({
  "../../node_modules/ajv/dist/compile/errors.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.extendErrors = exports2.resetErrorsCount = exports2.reportExtraError = exports2.reportError = exports2.keyword$DataError = exports2.keywordError = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    exports2.keywordError = {
      message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
    };
    exports2.keyword$DataError = {
      message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
    };
    function reportError(cxt, error = exports2.keywordError, errorPaths, overrideAllErrors) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) {
        addError(gen, errObj);
      } else {
        returnErrors(it, (0, codegen_1._)`[${errObj}]`);
      }
    }
    exports2.reportError = reportError;
    function reportExtraError(cxt, error = exports2.keywordError, errorPaths) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      addError(gen, errObj);
      if (!(compositeRule || allErrors)) {
        returnErrors(it, names_1.default.vErrors);
      }
    }
    exports2.reportExtraError = reportExtraError;
    function resetErrorsCount(gen, errsCount) {
      gen.assign(names_1.default.errors, errsCount);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
    }
    exports2.resetErrorsCount = resetErrorsCount;
    function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
      if (errsCount === void 0)
        throw new Error("ajv implementation error");
      const err = gen.name("err");
      gen.forRange("i", errsCount, names_1.default.errors, (i) => {
        gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
        gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
        gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
        if (it.opts.verbose) {
          gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
          gen.assign((0, codegen_1._)`${err}.data`, data);
        }
      });
    }
    exports2.extendErrors = extendErrors;
    function addError(gen, errObj) {
      const err = gen.const("err", errObj);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
      gen.code((0, codegen_1._)`${names_1.default.errors}++`);
    }
    function returnErrors(it, errs) {
      const { gen, validateName, schemaEnv } = it;
      if (schemaEnv.$async) {
        gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
        gen.return(false);
      }
    }
    var E = {
      keyword: new codegen_1.Name("keyword"),
      schemaPath: new codegen_1.Name("schemaPath"),
      // also used in JTD errors
      params: new codegen_1.Name("params"),
      propertyName: new codegen_1.Name("propertyName"),
      message: new codegen_1.Name("message"),
      schema: new codegen_1.Name("schema"),
      parentSchema: new codegen_1.Name("parentSchema")
    };
    function errorObjectCode(cxt, error, errorPaths) {
      const { createErrors } = cxt.it;
      if (createErrors === false)
        return (0, codegen_1._)`{}`;
      return errorObject(cxt, error, errorPaths);
    }
    function errorObject(cxt, error, errorPaths = {}) {
      const { gen, it } = cxt;
      const keyValues = [
        errorInstancePath(it, errorPaths),
        errorSchemaPath(cxt, errorPaths)
      ];
      extraErrorProps(cxt, error, keyValues);
      return gen.object(...keyValues);
    }
    function errorInstancePath({ errorPath }, { instancePath }) {
      const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
      return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
    }
    function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
      let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
      if (schemaPath) {
        schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
      }
      return [E.schemaPath, schPath];
    }
    function extraErrorProps(cxt, { params, message }, keyValues) {
      const { keyword, data, schemaValue, it } = cxt;
      const { opts, propertyName, topSchemaRef, schemaPath } = it;
      keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
      if (opts.messages) {
        keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
      }
      if (opts.verbose) {
        keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
      }
      if (propertyName)
        keyValues.push([E.propertyName, propertyName]);
    }
  }
});

// ../../node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/boolSchema.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.boolOrEmptySchema = exports2.topBoolOrEmptySchema = void 0;
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var boolError = {
      message: "boolean schema is false"
    };
    function topBoolOrEmptySchema(it) {
      const { gen, schema, validateName } = it;
      if (schema === false) {
        falseSchemaError(it, false);
      } else if (typeof schema == "object" && schema.$async === true) {
        gen.return(names_1.default.data);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, null);
        gen.return(true);
      }
    }
    exports2.topBoolOrEmptySchema = topBoolOrEmptySchema;
    function boolOrEmptySchema(it, valid) {
      const { gen, schema } = it;
      if (schema === false) {
        gen.var(valid, false);
        falseSchemaError(it);
      } else {
        gen.var(valid, true);
      }
    }
    exports2.boolOrEmptySchema = boolOrEmptySchema;
    function falseSchemaError(it, overrideAllErrors) {
      const { gen, data } = it;
      const cxt = {
        gen,
        keyword: "false schema",
        data,
        schema: false,
        schemaCode: false,
        schemaValue: false,
        params: {},
        it
      };
      (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
    }
  }
});

// ../../node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS({
  "../../node_modules/ajv/dist/compile/rules.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getRules = exports2.isJSONType = void 0;
    var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
    var jsonTypes = new Set(_jsonTypes);
    function isJSONType(x) {
      return typeof x == "string" && jsonTypes.has(x);
    }
    exports2.isJSONType = isJSONType;
    function getRules() {
      const groups = {
        number: { type: "number", rules: [] },
        string: { type: "string", rules: [] },
        array: { type: "array", rules: [] },
        object: { type: "object", rules: [] }
      };
      return {
        types: { ...groups, integer: true, boolean: true, null: true },
        rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
        post: { rules: [] },
        all: {},
        keywords: {}
      };
    }
    exports2.getRules = getRules;
  }
});

// ../../node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/applicability.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.shouldUseRule = exports2.shouldUseGroup = exports2.schemaHasRulesForType = void 0;
    function schemaHasRulesForType({ schema, self }, type) {
      const group = self.RULES.types[type];
      return group && group !== true && shouldUseGroup(schema, group);
    }
    exports2.schemaHasRulesForType = schemaHasRulesForType;
    function shouldUseGroup(schema, group) {
      return group.rules.some((rule) => shouldUseRule(schema, rule));
    }
    exports2.shouldUseGroup = shouldUseGroup;
    function shouldUseRule(schema, rule) {
      var _a;
      return schema[rule.keyword] !== void 0 || ((_a = rule.definition.implements) === null || _a === void 0 ? void 0 : _a.some((kwd) => schema[kwd] !== void 0));
    }
    exports2.shouldUseRule = shouldUseRule;
  }
});

// ../../node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/dataType.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.reportTypeError = exports2.checkDataTypes = exports2.checkDataType = exports2.coerceAndCheckDataType = exports2.getJSONTypes = exports2.getSchemaTypes = exports2.DataType = void 0;
    var rules_1 = require_rules();
    var applicability_1 = require_applicability();
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Correct"] = 0] = "Correct";
      DataType2[DataType2["Wrong"] = 1] = "Wrong";
    })(DataType || (exports2.DataType = DataType = {}));
    function getSchemaTypes(schema) {
      const types = getJSONTypes(schema.type);
      const hasNull = types.includes("null");
      if (hasNull) {
        if (schema.nullable === false)
          throw new Error("type: null contradicts nullable: false");
      } else {
        if (!types.length && schema.nullable !== void 0) {
          throw new Error('"nullable" cannot be used without "type"');
        }
        if (schema.nullable === true)
          types.push("null");
      }
      return types;
    }
    exports2.getSchemaTypes = getSchemaTypes;
    function getJSONTypes(ts) {
      const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
      if (types.every(rules_1.isJSONType))
        return types;
      throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
    }
    exports2.getJSONTypes = getJSONTypes;
    function coerceAndCheckDataType(it, types) {
      const { gen, data, opts } = it;
      const coerceTo = coerceToTypes(types, opts.coerceTypes);
      const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
      if (checkTypes) {
        const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
        gen.if(wrongType, () => {
          if (coerceTo.length)
            coerceData(it, types, coerceTo);
          else
            reportTypeError(it);
        });
      }
      return checkTypes;
    }
    exports2.coerceAndCheckDataType = coerceAndCheckDataType;
    var COERCIBLE = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
    function coerceToTypes(types, coerceTypes) {
      return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
    }
    function coerceData(it, types, coerceTo) {
      const { gen, data, opts } = it;
      const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
      const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
      if (opts.coerceTypes === "array") {
        gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
      }
      gen.if((0, codegen_1._)`${coerced} !== undefined`);
      for (const t of coerceTo) {
        if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
          coerceSpecificType(t);
        }
      }
      gen.else();
      reportTypeError(it);
      gen.endIf();
      gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
        gen.assign(data, coerced);
        assignParentData(it, coerced);
      });
      function coerceSpecificType(t) {
        switch (t) {
          case "string":
            gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
            return;
          case "number":
            gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "integer":
            gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "boolean":
            gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
            return;
          case "null":
            gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
            gen.assign(coerced, null);
            return;
          case "array":
            gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
        }
      }
    }
    function assignParentData({ gen, parentData, parentDataProperty }, expr) {
      gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
    }
    function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
      const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
      let cond;
      switch (dataType) {
        case "null":
          return (0, codegen_1._)`${data} ${EQ} null`;
        case "array":
          cond = (0, codegen_1._)`Array.isArray(${data})`;
          break;
        case "object":
          cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
          break;
        case "integer":
          cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
          break;
        case "number":
          cond = numCond();
          break;
        default:
          return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
      }
      return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
      function numCond(_cond = codegen_1.nil) {
        return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
      }
    }
    exports2.checkDataType = checkDataType;
    function checkDataTypes(dataTypes, data, strictNums, correct) {
      if (dataTypes.length === 1) {
        return checkDataType(dataTypes[0], data, strictNums, correct);
      }
      let cond;
      const types = (0, util_1.toHash)(dataTypes);
      if (types.array && types.object) {
        const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
        cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
        delete types.null;
        delete types.array;
        delete types.object;
      } else {
        cond = codegen_1.nil;
      }
      if (types.number)
        delete types.integer;
      for (const t in types)
        cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
      return cond;
    }
    exports2.checkDataTypes = checkDataTypes;
    var typeError = {
      message: ({ schema }) => `must be ${schema}`,
      params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
    };
    function reportTypeError(it) {
      const cxt = getTypeErrorContext(it);
      (0, errors_1.reportError)(cxt, typeError);
    }
    exports2.reportTypeError = reportTypeError;
    function getTypeErrorContext(it) {
      const { gen, data, schema } = it;
      const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
      return {
        gen,
        keyword: "type",
        data,
        schema: schema.type,
        schemaCode,
        schemaValue: schemaCode,
        parentSchema: schema,
        params: {},
        it
      };
    }
  }
});

// ../../node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/defaults.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.assignDefaults = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function assignDefaults(it, ty) {
      const { properties, items } = it.schema;
      if (ty === "object" && properties) {
        for (const key in properties) {
          assignDefault(it, key, properties[key].default);
        }
      } else if (ty === "array" && Array.isArray(items)) {
        items.forEach((sch, i) => assignDefault(it, i, sch.default));
      }
    }
    exports2.assignDefaults = assignDefaults;
    function assignDefault(it, prop, defaultValue) {
      const { gen, compositeRule, data, opts } = it;
      if (defaultValue === void 0)
        return;
      const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
      if (compositeRule) {
        (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
        return;
      }
      let condition = (0, codegen_1._)`${childData} === undefined`;
      if (opts.useDefaults === "empty") {
        condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
      }
      gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
    }
  }
});

// ../../node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/code.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateUnion = exports2.validateArray = exports2.usePattern = exports2.callValidateCode = exports2.schemaProperties = exports2.allSchemaProperties = exports2.noPropertyInData = exports2.propertyInData = exports2.isOwnProperty = exports2.hasPropFunc = exports2.reportMissingProp = exports2.checkMissingProp = exports2.checkReportMissingProp = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var util_2 = require_util();
    function checkReportMissingProp(cxt, prop) {
      const { gen, data, it } = cxt;
      gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
        cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
        cxt.error();
      });
    }
    exports2.checkReportMissingProp = checkReportMissingProp;
    function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
      return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
    }
    exports2.checkMissingProp = checkMissingProp;
    function reportMissingProp(cxt, missing) {
      cxt.setParams({ missingProperty: missing }, true);
      cxt.error();
    }
    exports2.reportMissingProp = reportMissingProp;
    function hasPropFunc(gen) {
      return gen.scopeValue("func", {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        ref: Object.prototype.hasOwnProperty,
        code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
      });
    }
    exports2.hasPropFunc = hasPropFunc;
    function isOwnProperty(gen, data, property) {
      return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
    }
    exports2.isOwnProperty = isOwnProperty;
    function propertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
      return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
    }
    exports2.propertyInData = propertyInData;
    function noPropertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
      return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
    }
    exports2.noPropertyInData = noPropertyInData;
    function allSchemaProperties(schemaMap) {
      return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
    }
    exports2.allSchemaProperties = allSchemaProperties;
    function schemaProperties(it, schemaMap) {
      return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
    }
    exports2.schemaProperties = schemaProperties;
    function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
      const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
      const valCxt = [
        [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
        [names_1.default.parentData, it.parentData],
        [names_1.default.parentDataProperty, it.parentDataProperty],
        [names_1.default.rootData, names_1.default.rootData]
      ];
      if (it.opts.dynamicRef)
        valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
      const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
      return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
    }
    exports2.callValidateCode = callValidateCode;
    var newRegExp = (0, codegen_1._)`new RegExp`;
    function usePattern({ gen, it: { opts } }, pattern) {
      const u = opts.unicodeRegExp ? "u" : "";
      const { regExp } = opts.code;
      const rx = regExp(pattern, u);
      return gen.scopeValue("pattern", {
        key: rx.toString(),
        ref: rx,
        code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
      });
    }
    exports2.usePattern = usePattern;
    function validateArray(cxt) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      if (it.allErrors) {
        const validArr = gen.let("valid", true);
        validateItems(() => gen.assign(validArr, false));
        return validArr;
      }
      gen.var(valid, true);
      validateItems(() => gen.break());
      return valid;
      function validateItems(notValid) {
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword,
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          gen.if((0, codegen_1.not)(valid), notValid);
        });
      }
    }
    exports2.validateArray = validateArray;
    function validateUnion(cxt) {
      const { gen, schema, keyword, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
      if (alwaysValid && !it.opts.unevaluated)
        return;
      const valid = gen.let("valid", false);
      const schValid = gen.name("_valid");
      gen.block(() => schema.forEach((_sch, i) => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: i,
          compositeRule: true
        }, schValid);
        gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
        const merged = cxt.mergeValidEvaluated(schCxt, schValid);
        if (!merged)
          gen.if((0, codegen_1.not)(valid));
      }));
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    }
    exports2.validateUnion = validateUnion;
  }
});

// ../../node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/keyword.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateKeywordUsage = exports2.validSchemaType = exports2.funcKeywordCode = exports2.macroKeywordCode = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var code_1 = require_code2();
    var errors_1 = require_errors();
    function macroKeywordCode(cxt, def) {
      const { gen, keyword, schema, parentSchema, it } = cxt;
      const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
      const schemaRef = useKeyword(gen, keyword, macroSchema);
      if (it.opts.validateSchema !== false)
        it.self.validateSchema(macroSchema, true);
      const valid = gen.name("valid");
      cxt.subschema({
        schema: macroSchema,
        schemaPath: codegen_1.nil,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`,
        topSchemaRef: schemaRef,
        compositeRule: true
      }, valid);
      cxt.pass(valid, () => cxt.error(true));
    }
    exports2.macroKeywordCode = macroKeywordCode;
    function funcKeywordCode(cxt, def) {
      var _a;
      const { gen, keyword, schema, parentSchema, $data, it } = cxt;
      checkAsyncKeyword(it, def);
      const validate = !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate;
      const validateRef = useKeyword(gen, keyword, validate);
      const valid = gen.let("valid");
      cxt.block$data(valid, validateKeyword);
      cxt.ok((_a = def.valid) !== null && _a !== void 0 ? _a : valid);
      function validateKeyword() {
        if (def.errors === false) {
          assignValid();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => cxt.error());
        } else {
          const ruleErrs = def.async ? validateAsync() : validateSync();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => addErrs(cxt, ruleErrs));
        }
      }
      function validateAsync() {
        const ruleErrs = gen.let("ruleErrs", null);
        gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
        return ruleErrs;
      }
      function validateSync() {
        const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
        gen.assign(validateErrs, null);
        assignValid(codegen_1.nil);
        return validateErrs;
      }
      function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
        const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
        const passSchema = !("compile" in def && !$data || def.schema === false);
        gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
      }
      function reportErrs(errors) {
        var _a2;
        gen.if((0, codegen_1.not)((_a2 = def.valid) !== null && _a2 !== void 0 ? _a2 : valid), errors);
      }
    }
    exports2.funcKeywordCode = funcKeywordCode;
    function modifyData(cxt) {
      const { gen, data, it } = cxt;
      gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
    }
    function addErrs(cxt, errs) {
      const { gen } = cxt;
      gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
        (0, errors_1.extendErrors)(cxt);
      }, () => cxt.error());
    }
    function checkAsyncKeyword({ schemaEnv }, def) {
      if (def.async && !schemaEnv.$async)
        throw new Error("async keyword in sync schema");
    }
    function useKeyword(gen, keyword, result) {
      if (result === void 0)
        throw new Error(`keyword "${keyword}" failed to compile`);
      return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
    }
    function validSchemaType(schema, schemaType, allowUndefined = false) {
      return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
    }
    exports2.validSchemaType = validSchemaType;
    function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
      if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) {
        throw new Error("ajv implementation error");
      }
      const deps = def.dependencies;
      if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
        throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
      }
      if (def.validateSchema) {
        const valid = def.validateSchema(schema[keyword]);
        if (!valid) {
          const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
          if (opts.validateSchema === "log")
            self.logger.error(msg);
          else
            throw new Error(msg);
        }
      }
    }
    exports2.validateKeywordUsage = validateKeywordUsage;
  }
});

// ../../node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/subschema.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.extendSubschemaMode = exports2.extendSubschemaData = exports2.getSubschema = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
      if (keyword !== void 0 && schema !== void 0) {
        throw new Error('both "keyword" and "schema" passed, only one allowed');
      }
      if (keyword !== void 0) {
        const sch = it.schema[keyword];
        return schemaProp === void 0 ? {
          schema: sch,
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}`
        } : {
          schema: sch[schemaProp],
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
        };
      }
      if (schema !== void 0) {
        if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) {
          throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
        }
        return {
          schema,
          schemaPath,
          topSchemaRef,
          errSchemaPath
        };
      }
      throw new Error('either "keyword" or "schema" must be passed');
    }
    exports2.getSubschema = getSubschema;
    function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
      if (data !== void 0 && dataProp !== void 0) {
        throw new Error('both "data" and "dataProp" passed, only one allowed');
      }
      const { gen } = it;
      if (dataProp !== void 0) {
        const { errorPath, dataPathArr, opts } = it;
        const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
        dataContextProps(nextData);
        subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
        subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
        subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
      }
      if (data !== void 0) {
        const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
        dataContextProps(nextData);
        if (propertyName !== void 0)
          subschema.propertyName = propertyName;
      }
      if (dataTypes)
        subschema.dataTypes = dataTypes;
      function dataContextProps(_nextData) {
        subschema.data = _nextData;
        subschema.dataLevel = it.dataLevel + 1;
        subschema.dataTypes = [];
        it.definedProperties = /* @__PURE__ */ new Set();
        subschema.parentData = it.data;
        subschema.dataNames = [...it.dataNames, _nextData];
      }
    }
    exports2.extendSubschemaData = extendSubschemaData;
    function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
      if (compositeRule !== void 0)
        subschema.compositeRule = compositeRule;
      if (createErrors !== void 0)
        subschema.createErrors = createErrors;
      if (allErrors !== void 0)
        subschema.allErrors = allErrors;
      subschema.jtdDiscriminator = jtdDiscriminator;
      subschema.jtdMetadata = jtdMetadata;
    }
    exports2.extendSubschemaMode = extendSubschemaMode;
  }
});

// ../../node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "../../node_modules/fast-deep-equal/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// ../../node_modules/ajv/node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS({
  "../../node_modules/ajv/node_modules/json-schema-traverse/index.js"(exports2, module2) {
    "use strict";
    var traverse = module2.exports = function(schema, opts, cb) {
      if (typeof opts == "function") {
        cb = opts;
        opts = {};
      }
      cb = opts.cb || cb;
      var pre = typeof cb == "function" ? cb : cb.pre || function() {
      };
      var post = cb.post || function() {
      };
      _traverse(opts, pre, post, schema, "", schema);
    };
    traverse.keywords = {
      additionalItems: true,
      items: true,
      contains: true,
      additionalProperties: true,
      propertyNames: true,
      not: true,
      if: true,
      then: true,
      else: true
    };
    traverse.arrayKeywords = {
      items: true,
      allOf: true,
      anyOf: true,
      oneOf: true
    };
    traverse.propsKeywords = {
      $defs: true,
      definitions: true,
      properties: true,
      patternProperties: true,
      dependencies: true
    };
    traverse.skipKeywords = {
      default: true,
      enum: true,
      const: true,
      required: true,
      maximum: true,
      minimum: true,
      exclusiveMaximum: true,
      exclusiveMinimum: true,
      multipleOf: true,
      maxLength: true,
      minLength: true,
      pattern: true,
      format: true,
      maxItems: true,
      minItems: true,
      uniqueItems: true,
      maxProperties: true,
      minProperties: true
    };
    function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
      if (schema && typeof schema == "object" && !Array.isArray(schema)) {
        pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
        for (var key in schema) {
          var sch = schema[key];
          if (Array.isArray(sch)) {
            if (key in traverse.arrayKeywords) {
              for (var i = 0; i < sch.length; i++)
                _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
            }
          } else if (key in traverse.propsKeywords) {
            if (sch && typeof sch == "object") {
              for (var prop in sch)
                _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
            }
          } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
            _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
          }
        }
        post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      }
    }
    function escapeJsonPtr(str) {
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
  }
});

// ../../node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS({
  "../../node_modules/ajv/dist/compile/resolve.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getSchemaRefs = exports2.resolveUrl = exports2.normalizeId = exports2._getFullPath = exports2.getFullPath = exports2.inlineRef = void 0;
    var util_1 = require_util();
    var equal = require_fast_deep_equal();
    var traverse = require_json_schema_traverse();
    var SIMPLE_INLINED = /* @__PURE__ */ new Set([
      "type",
      "format",
      "pattern",
      "maxLength",
      "minLength",
      "maxProperties",
      "minProperties",
      "maxItems",
      "minItems",
      "maximum",
      "minimum",
      "uniqueItems",
      "multipleOf",
      "required",
      "enum",
      "const"
    ]);
    function inlineRef(schema, limit = true) {
      if (typeof schema == "boolean")
        return true;
      if (limit === true)
        return !hasRef(schema);
      if (!limit)
        return false;
      return countKeys(schema) <= limit;
    }
    exports2.inlineRef = inlineRef;
    var REF_KEYWORDS = /* @__PURE__ */ new Set([
      "$ref",
      "$recursiveRef",
      "$recursiveAnchor",
      "$dynamicRef",
      "$dynamicAnchor"
    ]);
    function hasRef(schema) {
      for (const key in schema) {
        if (REF_KEYWORDS.has(key))
          return true;
        const sch = schema[key];
        if (Array.isArray(sch) && sch.some(hasRef))
          return true;
        if (typeof sch == "object" && hasRef(sch))
          return true;
      }
      return false;
    }
    function countKeys(schema) {
      let count = 0;
      for (const key in schema) {
        if (key === "$ref")
          return Infinity;
        count++;
        if (SIMPLE_INLINED.has(key))
          continue;
        if (typeof schema[key] == "object") {
          (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
        }
        if (count === Infinity)
          return Infinity;
      }
      return count;
    }
    function getFullPath(resolver, id = "", normalize) {
      if (normalize !== false)
        id = normalizeId(id);
      const p = resolver.parse(id);
      return _getFullPath(resolver, p);
    }
    exports2.getFullPath = getFullPath;
    function _getFullPath(resolver, p) {
      const serialized = resolver.serialize(p);
      return serialized.split("#")[0] + "#";
    }
    exports2._getFullPath = _getFullPath;
    var TRAILING_SLASH_HASH = /#\/?$/;
    function normalizeId(id) {
      return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
    }
    exports2.normalizeId = normalizeId;
    function resolveUrl(resolver, baseId, id) {
      id = normalizeId(id);
      return resolver.resolve(baseId, id);
    }
    exports2.resolveUrl = resolveUrl;
    var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
    function getSchemaRefs(schema, baseId) {
      if (typeof schema == "boolean")
        return {};
      const { schemaId, uriResolver } = this.opts;
      const schId = normalizeId(schema[schemaId] || baseId);
      const baseIds = { "": schId };
      const pathPrefix = getFullPath(uriResolver, schId, false);
      const localRefs = {};
      const schemaRefs = /* @__PURE__ */ new Set();
      traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
        if (parentJsonPtr === void 0)
          return;
        const fullPath = pathPrefix + jsonPtr;
        let innerBaseId = baseIds[parentJsonPtr];
        if (typeof sch[schemaId] == "string")
          innerBaseId = addRef.call(this, sch[schemaId]);
        addAnchor.call(this, sch.$anchor);
        addAnchor.call(this, sch.$dynamicAnchor);
        baseIds[jsonPtr] = innerBaseId;
        function addRef(ref) {
          const _resolve = this.opts.uriResolver.resolve;
          ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
          if (schemaRefs.has(ref))
            throw ambiguos(ref);
          schemaRefs.add(ref);
          let schOrRef = this.refs[ref];
          if (typeof schOrRef == "string")
            schOrRef = this.refs[schOrRef];
          if (typeof schOrRef == "object") {
            checkAmbiguosRef(sch, schOrRef.schema, ref);
          } else if (ref !== normalizeId(fullPath)) {
            if (ref[0] === "#") {
              checkAmbiguosRef(sch, localRefs[ref], ref);
              localRefs[ref] = sch;
            } else {
              this.refs[ref] = fullPath;
            }
          }
          return ref;
        }
        function addAnchor(anchor) {
          if (typeof anchor == "string") {
            if (!ANCHOR.test(anchor))
              throw new Error(`invalid anchor "${anchor}"`);
            addRef.call(this, `#${anchor}`);
          }
        }
      });
      return localRefs;
      function checkAmbiguosRef(sch1, sch2, ref) {
        if (sch2 !== void 0 && !equal(sch1, sch2))
          throw ambiguos(ref);
      }
      function ambiguos(ref) {
        return new Error(`reference "${ref}" resolves to more than one schema`);
      }
    }
    exports2.getSchemaRefs = getSchemaRefs;
  }
});

// ../../node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS({
  "../../node_modules/ajv/dist/compile/validate/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getData = exports2.KeywordCxt = exports2.validateFunctionCode = void 0;
    var boolSchema_1 = require_boolSchema();
    var dataType_1 = require_dataType();
    var applicability_1 = require_applicability();
    var dataType_2 = require_dataType();
    var defaults_1 = require_defaults();
    var keyword_1 = require_keyword();
    var subschema_1 = require_subschema();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var errors_1 = require_errors();
    function validateFunctionCode(it) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          topSchemaObjCode(it);
          return;
        }
      }
      validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
    }
    exports2.validateFunctionCode = validateFunctionCode;
    function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
      if (opts.code.es5) {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
          gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
          destructureValCxtES5(gen, opts);
          gen.code(body);
        });
      } else {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
      }
    }
    function destructureValCxt(opts) {
      return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
    }
    function destructureValCxtES5(gen, opts) {
      gen.if(names_1.default.valCxt, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
        gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
      }, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.rootData, names_1.default.data);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
      });
    }
    function topSchemaObjCode(it) {
      const { schema, opts, gen } = it;
      validateFunction(it, () => {
        if (opts.$comment && schema.$comment)
          commentKeyword(it);
        checkNoDefault(it);
        gen.let(names_1.default.vErrors, null);
        gen.let(names_1.default.errors, 0);
        if (opts.unevaluated)
          resetEvaluated(it);
        typeAndKeywords(it);
        returnResults(it);
      });
      return;
    }
    function resetEvaluated(it) {
      const { gen, validateName } = it;
      it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
    }
    function funcSourceUrl(schema, opts) {
      const schId = typeof schema == "object" && schema[opts.schemaId];
      return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
    }
    function subschemaCode(it, valid) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          subSchemaObjCode(it, valid);
          return;
        }
      }
      (0, boolSchema_1.boolOrEmptySchema)(it, valid);
    }
    function schemaCxtHasRules({ schema, self }) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (self.RULES.all[key])
          return true;
      return false;
    }
    function isSchemaObj(it) {
      return typeof it.schema != "boolean";
    }
    function subSchemaObjCode(it, valid) {
      const { schema, gen, opts } = it;
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      updateContext(it);
      checkAsyncSchema(it);
      const errsCount = gen.const("_errs", names_1.default.errors);
      typeAndKeywords(it, errsCount);
      gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
    }
    function checkKeywords(it) {
      (0, util_1.checkUnknownRules)(it);
      checkRefsAndKeywords(it);
    }
    function typeAndKeywords(it, errsCount) {
      if (it.opts.jtd)
        return schemaKeywords(it, [], false, errsCount);
      const types = (0, dataType_1.getSchemaTypes)(it.schema);
      const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
      schemaKeywords(it, types, !checkedTypes, errsCount);
    }
    function checkRefsAndKeywords(it) {
      const { schema, errSchemaPath, opts, self } = it;
      if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
        self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
      }
    }
    function checkNoDefault(it) {
      const { schema, opts } = it;
      if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) {
        (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
      }
    }
    function updateContext(it) {
      const schId = it.schema[it.opts.schemaId];
      if (schId)
        it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
    }
    function checkAsyncSchema(it) {
      if (it.schema.$async && !it.schemaEnv.$async)
        throw new Error("async schema in sync schema");
    }
    function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
      const msg = schema.$comment;
      if (opts.$comment === true) {
        gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
      } else if (typeof opts.$comment == "function") {
        const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
        const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
        gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
      }
    }
    function returnResults(it) {
      const { gen, schemaEnv, validateName, ValidationError, opts } = it;
      if (schemaEnv.$async) {
        gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
        if (opts.unevaluated)
          assignEvaluated(it);
        gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
      }
    }
    function assignEvaluated({ gen, evaluated, props, items }) {
      if (props instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.props`, props);
      if (items instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.items`, items);
    }
    function schemaKeywords(it, types, typeErrors, errsCount) {
      const { gen, schema, data, allErrors, opts, self } = it;
      const { RULES } = self;
      if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
        gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
        return;
      }
      if (!opts.jtd)
        checkStrictTypes(it, types);
      gen.block(() => {
        for (const group of RULES.rules)
          groupKeywords(group);
        groupKeywords(RULES.post);
      });
      function groupKeywords(group) {
        if (!(0, applicability_1.shouldUseGroup)(schema, group))
          return;
        if (group.type) {
          gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
          iterateKeywords(it, group);
          if (types.length === 1 && types[0] === group.type && typeErrors) {
            gen.else();
            (0, dataType_2.reportTypeError)(it);
          }
          gen.endIf();
        } else {
          iterateKeywords(it, group);
        }
        if (!allErrors)
          gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
      }
    }
    function iterateKeywords(it, group) {
      const { gen, schema, opts: { useDefaults } } = it;
      if (useDefaults)
        (0, defaults_1.assignDefaults)(it, group.type);
      gen.block(() => {
        for (const rule of group.rules) {
          if ((0, applicability_1.shouldUseRule)(schema, rule)) {
            keywordCode(it, rule.keyword, rule.definition, group.type);
          }
        }
      });
    }
    function checkStrictTypes(it, types) {
      if (it.schemaEnv.meta || !it.opts.strictTypes)
        return;
      checkContextTypes(it, types);
      if (!it.opts.allowUnionTypes)
        checkMultipleTypes(it, types);
      checkKeywordTypes(it, it.dataTypes);
    }
    function checkContextTypes(it, types) {
      if (!types.length)
        return;
      if (!it.dataTypes.length) {
        it.dataTypes = types;
        return;
      }
      types.forEach((t) => {
        if (!includesType(it.dataTypes, t)) {
          strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
        }
      });
      narrowSchemaTypes(it, types);
    }
    function checkMultipleTypes(it, ts) {
      if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
        strictTypesError(it, "use allowUnionTypes to allow union type keyword");
      }
    }
    function checkKeywordTypes(it, ts) {
      const rules = it.self.RULES.all;
      for (const keyword in rules) {
        const rule = rules[keyword];
        if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
          const { type } = rule.definition;
          if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
            strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
          }
        }
      }
    }
    function hasApplicableType(schTs, kwdT) {
      return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
    }
    function includesType(ts, t) {
      return ts.includes(t) || t === "integer" && ts.includes("number");
    }
    function narrowSchemaTypes(it, withTypes) {
      const ts = [];
      for (const t of it.dataTypes) {
        if (includesType(withTypes, t))
          ts.push(t);
        else if (withTypes.includes("integer") && t === "number")
          ts.push("integer");
      }
      it.dataTypes = ts;
    }
    function strictTypesError(it, msg) {
      const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
      msg += ` at "${schemaPath}" (strictTypes)`;
      (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
    }
    var KeywordCxt = class {
      constructor(it, def, keyword) {
        (0, keyword_1.validateKeywordUsage)(it, def, keyword);
        this.gen = it.gen;
        this.allErrors = it.allErrors;
        this.keyword = keyword;
        this.data = it.data;
        this.schema = it.schema[keyword];
        this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
        this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
        this.schemaType = def.schemaType;
        this.parentSchema = it.schema;
        this.params = {};
        this.it = it;
        this.def = def;
        if (this.$data) {
          this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
        } else {
          this.schemaCode = this.schemaValue;
          if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) {
            throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
          }
        }
        if ("code" in def ? def.trackErrors : def.errors !== false) {
          this.errsCount = it.gen.const("_errs", names_1.default.errors);
        }
      }
      result(condition, successAction, failAction) {
        this.failResult((0, codegen_1.not)(condition), successAction, failAction);
      }
      failResult(condition, successAction, failAction) {
        this.gen.if(condition);
        if (failAction)
          failAction();
        else
          this.error();
        if (successAction) {
          this.gen.else();
          successAction();
          if (this.allErrors)
            this.gen.endIf();
        } else {
          if (this.allErrors)
            this.gen.endIf();
          else
            this.gen.else();
        }
      }
      pass(condition, failAction) {
        this.failResult((0, codegen_1.not)(condition), void 0, failAction);
      }
      fail(condition) {
        if (condition === void 0) {
          this.error();
          if (!this.allErrors)
            this.gen.if(false);
          return;
        }
        this.gen.if(condition);
        this.error();
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
      fail$data(condition) {
        if (!this.$data)
          return this.fail(condition);
        const { schemaCode } = this;
        this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
      }
      error(append, errorParams, errorPaths) {
        if (errorParams) {
          this.setParams(errorParams);
          this._error(append, errorPaths);
          this.setParams({});
          return;
        }
        this._error(append, errorPaths);
      }
      _error(append, errorPaths) {
        ;
        (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
      }
      $dataError() {
        (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
      }
      reset() {
        if (this.errsCount === void 0)
          throw new Error('add "trackErrors" to keyword definition');
        (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
      }
      ok(cond) {
        if (!this.allErrors)
          this.gen.if(cond);
      }
      setParams(obj, assign) {
        if (assign)
          Object.assign(this.params, obj);
        else
          this.params = obj;
      }
      block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
        this.gen.block(() => {
          this.check$data(valid, $dataValid);
          codeBlock();
        });
      }
      check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
        if (!this.$data)
          return;
        const { gen, schemaCode, schemaType, def } = this;
        gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
        if (valid !== codegen_1.nil)
          gen.assign(valid, true);
        if (schemaType.length || def.validateSchema) {
          gen.elseIf(this.invalid$data());
          this.$dataError();
          if (valid !== codegen_1.nil)
            gen.assign(valid, false);
        }
        gen.else();
      }
      invalid$data() {
        const { gen, schemaCode, schemaType, def, it } = this;
        return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
        function wrong$DataType() {
          if (schemaType.length) {
            if (!(schemaCode instanceof codegen_1.Name))
              throw new Error("ajv implementation error");
            const st = Array.isArray(schemaType) ? schemaType : [schemaType];
            return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
          }
          return codegen_1.nil;
        }
        function invalid$DataSchema() {
          if (def.validateSchema) {
            const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
            return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
          }
          return codegen_1.nil;
        }
      }
      subschema(appl, valid) {
        const subschema = (0, subschema_1.getSubschema)(this.it, appl);
        (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
        (0, subschema_1.extendSubschemaMode)(subschema, appl);
        const nextContext = { ...this.it, ...subschema, items: void 0, props: void 0 };
        subschemaCode(nextContext, valid);
        return nextContext;
      }
      mergeEvaluated(schemaCxt, toName) {
        const { it, gen } = this;
        if (!it.opts.unevaluated)
          return;
        if (it.props !== true && schemaCxt.props !== void 0) {
          it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
        }
        if (it.items !== true && schemaCxt.items !== void 0) {
          it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
        }
      }
      mergeValidEvaluated(schemaCxt, valid) {
        const { it, gen } = this;
        if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
          gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
          return true;
        }
      }
    };
    exports2.KeywordCxt = KeywordCxt;
    function keywordCode(it, keyword, def, ruleType) {
      const cxt = new KeywordCxt(it, def, keyword);
      if ("code" in def) {
        def.code(cxt, ruleType);
      } else if (cxt.$data && def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      } else if ("macro" in def) {
        (0, keyword_1.macroKeywordCode)(cxt, def);
      } else if (def.compile || def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      }
    }
    var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
    var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
    function getData($data, { dataLevel, dataNames, dataPathArr }) {
      let jsonPointer;
      let data;
      if ($data === "")
        return names_1.default.rootData;
      if ($data[0] === "/") {
        if (!JSON_POINTER.test($data))
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        jsonPointer = $data;
        data = names_1.default.rootData;
      } else {
        const matches = RELATIVE_JSON_POINTER.exec($data);
        if (!matches)
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        const up = +matches[1];
        jsonPointer = matches[2];
        if (jsonPointer === "#") {
          if (up >= dataLevel)
            throw new Error(errorMsg("property/index", up));
          return dataPathArr[dataLevel - up];
        }
        if (up > dataLevel)
          throw new Error(errorMsg("data", up));
        data = dataNames[dataLevel - up];
        if (!jsonPointer)
          return data;
      }
      let expr = data;
      const segments = jsonPointer.split("/");
      for (const segment of segments) {
        if (segment) {
          data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
          expr = (0, codegen_1._)`${expr} && ${data}`;
        }
      }
      return expr;
      function errorMsg(pointerType, up) {
        return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
      }
    }
    exports2.getData = getData;
  }
});

// ../../node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS({
  "../../node_modules/ajv/dist/runtime/validation_error.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var ValidationError = class extends Error {
      constructor(errors) {
        super("validation failed");
        this.errors = errors;
        this.ajv = this.validation = true;
      }
    };
    exports2.default = ValidationError;
  }
});

// ../../node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS({
  "../../node_modules/ajv/dist/compile/ref_error.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var resolve_1 = require_resolve();
    var MissingRefError = class extends Error {
      constructor(resolver, baseId, ref, msg) {
        super(msg || `can't resolve reference ${ref} from id ${baseId}`);
        this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
        this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
      }
    };
    exports2.default = MissingRefError;
  }
});

// ../../node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS({
  "../../node_modules/ajv/dist/compile/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.resolveSchema = exports2.getCompilingSchema = exports2.resolveRef = exports2.compileSchema = exports2.SchemaEnv = void 0;
    var codegen_1 = require_codegen();
    var validation_error_1 = require_validation_error();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var validate_1 = require_validate();
    var SchemaEnv = class {
      constructor(env) {
        var _a;
        this.refs = {};
        this.dynamicAnchors = {};
        let schema;
        if (typeof env.schema == "object")
          schema = env.schema;
        this.schema = env.schema;
        this.schemaId = env.schemaId;
        this.root = env.root || this;
        this.baseId = (_a = env.baseId) !== null && _a !== void 0 ? _a : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
        this.schemaPath = env.schemaPath;
        this.localRefs = env.localRefs;
        this.meta = env.meta;
        this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
        this.refs = {};
      }
    };
    exports2.SchemaEnv = SchemaEnv;
    function compileSchema(sch) {
      const _sch = getCompilingSchema.call(this, sch);
      if (_sch)
        return _sch;
      const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
      const { es5, lines } = this.opts.code;
      const { ownProperties } = this.opts;
      const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
      let _ValidationError;
      if (sch.$async) {
        _ValidationError = gen.scopeValue("Error", {
          ref: validation_error_1.default,
          code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
        });
      }
      const validateName = gen.scopeName("validate");
      sch.validateName = validateName;
      const schemaCxt = {
        gen,
        allErrors: this.opts.allErrors,
        data: names_1.default.data,
        parentData: names_1.default.parentData,
        parentDataProperty: names_1.default.parentDataProperty,
        dataNames: [names_1.default.data],
        dataPathArr: [codegen_1.nil],
        // TODO can its length be used as dataLevel if nil is removed?
        dataLevel: 0,
        dataTypes: [],
        definedProperties: /* @__PURE__ */ new Set(),
        topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
        validateName,
        ValidationError: _ValidationError,
        schema: sch.schema,
        schemaEnv: sch,
        rootId,
        baseId: sch.baseId || rootId,
        schemaPath: codegen_1.nil,
        errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
        errorPath: (0, codegen_1._)`""`,
        opts: this.opts,
        self: this
      };
      let sourceCode;
      try {
        this._compilations.add(sch);
        (0, validate_1.validateFunctionCode)(schemaCxt);
        gen.optimize(this.opts.code.optimize);
        const validateCode = gen.toString();
        sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
        if (this.opts.code.process)
          sourceCode = this.opts.code.process(sourceCode, sch);
        const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
        const validate = makeValidate(this, this.scope.get());
        this.scope.value(validateName, { ref: validate });
        validate.errors = null;
        validate.schema = sch.schema;
        validate.schemaEnv = sch;
        if (sch.$async)
          validate.$async = true;
        if (this.opts.code.source === true) {
          validate.source = { validateName, validateCode, scopeValues: gen._values };
        }
        if (this.opts.unevaluated) {
          const { props, items } = schemaCxt;
          validate.evaluated = {
            props: props instanceof codegen_1.Name ? void 0 : props,
            items: items instanceof codegen_1.Name ? void 0 : items,
            dynamicProps: props instanceof codegen_1.Name,
            dynamicItems: items instanceof codegen_1.Name
          };
          if (validate.source)
            validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
        }
        sch.validate = validate;
        return sch;
      } catch (e) {
        delete sch.validate;
        delete sch.validateName;
        if (sourceCode)
          this.logger.error("Error compiling schema, function code:", sourceCode);
        throw e;
      } finally {
        this._compilations.delete(sch);
      }
    }
    exports2.compileSchema = compileSchema;
    function resolveRef(root, baseId, ref) {
      var _a;
      ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
      const schOrFunc = root.refs[ref];
      if (schOrFunc)
        return schOrFunc;
      let _sch = resolve4.call(this, root, ref);
      if (_sch === void 0) {
        const schema = (_a = root.localRefs) === null || _a === void 0 ? void 0 : _a[ref];
        const { schemaId } = this.opts;
        if (schema)
          _sch = new SchemaEnv({ schema, schemaId, root, baseId });
      }
      if (_sch === void 0)
        return;
      return root.refs[ref] = inlineOrCompile.call(this, _sch);
    }
    exports2.resolveRef = resolveRef;
    function inlineOrCompile(sch) {
      if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
        return sch.schema;
      return sch.validate ? sch : compileSchema.call(this, sch);
    }
    function getCompilingSchema(schEnv) {
      for (const sch of this._compilations) {
        if (sameSchemaEnv(sch, schEnv))
          return sch;
      }
    }
    exports2.getCompilingSchema = getCompilingSchema;
    function sameSchemaEnv(s1, s2) {
      return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
    }
    function resolve4(root, ref) {
      let sch;
      while (typeof (sch = this.refs[ref]) == "string")
        ref = sch;
      return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
    }
    function resolveSchema(root, ref) {
      const p = this.opts.uriResolver.parse(ref);
      const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
      let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
      if (Object.keys(root.schema).length > 0 && refPath === baseId) {
        return getJsonPointer.call(this, p, root);
      }
      const id = (0, resolve_1.normalizeId)(refPath);
      const schOrRef = this.refs[id] || this.schemas[id];
      if (typeof schOrRef == "string") {
        const sch = resolveSchema.call(this, root, schOrRef);
        if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object")
          return;
        return getJsonPointer.call(this, p, sch);
      }
      if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object")
        return;
      if (!schOrRef.validate)
        compileSchema.call(this, schOrRef);
      if (id === (0, resolve_1.normalizeId)(ref)) {
        const { schema } = schOrRef;
        const { schemaId } = this.opts;
        const schId = schema[schemaId];
        if (schId)
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        return new SchemaEnv({ schema, schemaId, root, baseId });
      }
      return getJsonPointer.call(this, p, schOrRef);
    }
    exports2.resolveSchema = resolveSchema;
    var PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
      "properties",
      "patternProperties",
      "enum",
      "dependencies",
      "definitions"
    ]);
    function getJsonPointer(parsedRef, { baseId, schema, root }) {
      var _a;
      if (((_a = parsedRef.fragment) === null || _a === void 0 ? void 0 : _a[0]) !== "/")
        return;
      for (const part of parsedRef.fragment.slice(1).split("/")) {
        if (typeof schema === "boolean")
          return;
        const partSchema = schema[(0, util_1.unescapeFragment)(part)];
        if (partSchema === void 0)
          return;
        schema = partSchema;
        const schId = typeof schema === "object" && schema[this.opts.schemaId];
        if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        }
      }
      let env;
      if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
        const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
        env = resolveSchema.call(this, root, $ref);
      }
      const { schemaId } = this.opts;
      env = env || new SchemaEnv({ schema, schemaId, root, baseId });
      if (env.schema !== env.root.schema)
        return env;
      return void 0;
    }
  }
});

// ../../node_modules/ajv/dist/refs/data.json
var require_data = __commonJS({
  "../../node_modules/ajv/dist/refs/data.json"(exports2, module2) {
    module2.exports = {
      $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
      description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
      type: "object",
      required: ["$data"],
      properties: {
        $data: {
          type: "string",
          anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
        }
      },
      additionalProperties: false
    };
  }
});

// ../../node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS({
  "../../node_modules/fast-uri/lib/utils.js"(exports2, module2) {
    "use strict";
    var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
    var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
    var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
    var isPathCharacter = RegExp.prototype.test.bind(/^[\da-z\-._~!$&'()*+,;=:@/]$/iu);
    function stringArrayToHexStripped(input) {
      let acc = "";
      let code = 0;
      let i = 0;
      for (i = 0; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (code === 48) {
          continue;
        }
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
        break;
      }
      for (i += 1; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
      }
      return acc;
    }
    var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
    function consumeIsZone(buffer) {
      buffer.length = 0;
      return true;
    }
    function consumeHextets(buffer, address, output) {
      if (buffer.length) {
        const hex = stringArrayToHexStripped(buffer);
        if (hex !== "") {
          address.push(hex);
        } else {
          output.error = true;
          return false;
        }
        buffer.length = 0;
      }
      return true;
    }
    function getIPV6(input) {
      let tokenCount = 0;
      const output = { error: false, address: "", zone: "" };
      const address = [];
      const buffer = [];
      let endipv6Encountered = false;
      let endIpv6 = false;
      let consume = consumeHextets;
      for (let i = 0; i < input.length; i++) {
        const cursor = input[i];
        if (cursor === "[" || cursor === "]") {
          continue;
        }
        if (cursor === ":") {
          if (endipv6Encountered === true) {
            endIpv6 = true;
          }
          if (!consume(buffer, address, output)) {
            break;
          }
          if (++tokenCount > 7) {
            output.error = true;
            break;
          }
          if (i > 0 && input[i - 1] === ":") {
            endipv6Encountered = true;
          }
          address.push(":");
          continue;
        } else if (cursor === "%") {
          if (!consume(buffer, address, output)) {
            break;
          }
          consume = consumeIsZone;
        } else {
          buffer.push(cursor);
          continue;
        }
      }
      if (buffer.length) {
        if (consume === consumeIsZone) {
          output.zone = buffer.join("");
        } else if (endIpv6) {
          address.push(buffer.join(""));
        } else {
          address.push(stringArrayToHexStripped(buffer));
        }
      }
      output.address = address.join("");
      return output;
    }
    function normalizeIPv6(host) {
      if (findToken(host, ":") < 2) {
        return { host, isIPV6: false };
      }
      const ipv6 = getIPV6(host);
      if (!ipv6.error) {
        let newHost = ipv6.address;
        let escapedHost = ipv6.address;
        if (ipv6.zone) {
          newHost += "%" + ipv6.zone;
          escapedHost += "%25" + ipv6.zone;
        }
        return { host: newHost, isIPV6: true, escapedHost };
      } else {
        return { host, isIPV6: false };
      }
    }
    function findToken(str, token) {
      let ind = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === token) ind++;
      }
      return ind;
    }
    function removeDotSegments(path8) {
      let input = path8;
      const output = [];
      let nextSlash = -1;
      let len = 0;
      while (len = input.length) {
        if (len === 1) {
          if (input === ".") {
            break;
          } else if (input === "/") {
            output.push("/");
            break;
          } else {
            output.push(input);
            break;
          }
        } else if (len === 2) {
          if (input[0] === ".") {
            if (input[1] === ".") {
              break;
            } else if (input[1] === "/") {
              input = input.slice(2);
              continue;
            }
          } else if (input[0] === "/") {
            if (input[1] === "." || input[1] === "/") {
              output.push("/");
              break;
            }
          }
        } else if (len === 3) {
          if (input === "/..") {
            if (output.length !== 0) {
              output.pop();
            }
            output.push("/");
            break;
          }
        }
        if (input[0] === ".") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(3);
              continue;
            }
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(2);
              continue;
            } else if (input[2] === ".") {
              if (input[3] === "/") {
                input = input.slice(3);
                if (output.length !== 0) {
                  output.pop();
                }
                continue;
              }
            }
          }
        }
        if ((nextSlash = input.indexOf("/", 1)) === -1) {
          output.push(input);
          break;
        } else {
          output.push(input.slice(0, nextSlash));
          input = input.slice(nextSlash);
        }
      }
      return output.join("");
    }
    var HOST_DELIMS = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" };
    var HOST_DELIM_RE = /[@/?#:]/g;
    var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
    function reescapeHostDelimiters(host, isIP) {
      const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
      re.lastIndex = 0;
      return host.replace(re, (ch) => HOST_DELIMS[ch]);
    }
    function normalizePercentEncoding(input, decodeUnreserved = false) {
      if (input.indexOf("%") === -1) {
        return input;
      }
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decodeUnreserved && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        output += input[i];
      }
      return output;
    }
    function normalizePathEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decoded !== "." && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isPathCharacter(input[i])) {
          output += input[i];
        } else {
          output += escape(input[i]);
        }
      }
      return output;
    }
    function escapePreservingEscapes(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        output += escape(input[i]);
      }
      return output;
    }
    function recomposeAuthority(component) {
      const uriTokens = [];
      if (component.userinfo !== void 0) {
        uriTokens.push(component.userinfo);
        uriTokens.push("@");
      }
      if (component.host !== void 0) {
        let host = unescape(component.host);
        if (!isIPv4(host)) {
          const ipV6res = normalizeIPv6(host);
          if (ipV6res.isIPV6 === true) {
            host = `[${ipV6res.escapedHost}]`;
          } else {
            host = reescapeHostDelimiters(host, false);
          }
        }
        uriTokens.push(host);
      }
      if (typeof component.port === "number" || typeof component.port === "string") {
        uriTokens.push(":");
        uriTokens.push(String(component.port));
      }
      return uriTokens.length ? uriTokens.join("") : void 0;
    }
    module2.exports = {
      nonSimpleDomain,
      recomposeAuthority,
      reescapeHostDelimiters,
      normalizePercentEncoding,
      normalizePathEncoding,
      escapePreservingEscapes,
      removeDotSegments,
      isIPv4,
      isUUID,
      normalizeIPv6,
      stringArrayToHexStripped
    };
  }
});

// ../../node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS({
  "../../node_modules/fast-uri/lib/schemes.js"(exports2, module2) {
    "use strict";
    var { isUUID } = require_utils();
    var URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
    var supportedSchemeNames = (
      /** @type {const} */
      [
        "http",
        "https",
        "ws",
        "wss",
        "urn",
        "urn:uuid"
      ]
    );
    function isValidSchemeName(name) {
      return supportedSchemeNames.indexOf(
        /** @type {*} */
        name
      ) !== -1;
    }
    function wsIsSecure(wsComponent) {
      if (wsComponent.secure === true) {
        return true;
      } else if (wsComponent.secure === false) {
        return false;
      } else if (wsComponent.scheme) {
        return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
      } else {
        return false;
      }
    }
    function httpParse(component) {
      if (!component.host) {
        component.error = component.error || "HTTP URIs must have a host.";
      }
      return component;
    }
    function httpSerialize(component) {
      const secure = String(component.scheme).toLowerCase() === "https";
      if (component.port === (secure ? 443 : 80) || component.port === "") {
        component.port = void 0;
      }
      if (!component.path) {
        component.path = "/";
      }
      return component;
    }
    function wsParse(wsComponent) {
      wsComponent.secure = wsIsSecure(wsComponent);
      wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
      wsComponent.path = void 0;
      wsComponent.query = void 0;
      return wsComponent;
    }
    function wsSerialize(wsComponent) {
      if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
        wsComponent.port = void 0;
      }
      if (typeof wsComponent.secure === "boolean") {
        wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
        wsComponent.secure = void 0;
      }
      if (wsComponent.resourceName) {
        const [path8, query] = wsComponent.resourceName.split("?");
        wsComponent.path = path8 && path8 !== "/" ? path8 : void 0;
        wsComponent.query = query;
        wsComponent.resourceName = void 0;
      }
      wsComponent.fragment = void 0;
      return wsComponent;
    }
    function urnParse(urnComponent, options) {
      if (!urnComponent.path) {
        urnComponent.error = "URN can not be parsed";
        return urnComponent;
      }
      const matches = urnComponent.path.match(URN_REG);
      if (matches) {
        const scheme = options.scheme || urnComponent.scheme || "urn";
        urnComponent.nid = matches[1].toLowerCase();
        urnComponent.nss = matches[2];
        const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
        const schemeHandler = getSchemeHandler(urnScheme);
        urnComponent.path = void 0;
        if (schemeHandler) {
          urnComponent = schemeHandler.parse(urnComponent, options);
        }
      } else {
        urnComponent.error = urnComponent.error || "URN can not be parsed.";
      }
      return urnComponent;
    }
    function urnSerialize(urnComponent, options) {
      if (urnComponent.nid === void 0) {
        throw new Error("URN without nid cannot be serialized");
      }
      const scheme = options.scheme || urnComponent.scheme || "urn";
      const nid = urnComponent.nid.toLowerCase();
      const urnScheme = `${scheme}:${options.nid || nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      if (schemeHandler) {
        urnComponent = schemeHandler.serialize(urnComponent, options);
      }
      const uriComponent = urnComponent;
      const nss = urnComponent.nss;
      uriComponent.path = `${nid || options.nid}:${nss}`;
      options.skipEscape = true;
      return uriComponent;
    }
    function urnuuidParse(urnComponent, options) {
      const uuidComponent = urnComponent;
      uuidComponent.uuid = uuidComponent.nss;
      uuidComponent.nss = void 0;
      if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
        uuidComponent.error = uuidComponent.error || "UUID is not valid.";
      }
      return uuidComponent;
    }
    function urnuuidSerialize(uuidComponent) {
      const urnComponent = uuidComponent;
      urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
      return urnComponent;
    }
    var http = (
      /** @type {SchemeHandler} */
      {
        scheme: "http",
        domainHost: true,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var https = (
      /** @type {SchemeHandler} */
      {
        scheme: "https",
        domainHost: http.domainHost,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var ws = (
      /** @type {SchemeHandler} */
      {
        scheme: "ws",
        domainHost: true,
        parse: wsParse,
        serialize: wsSerialize
      }
    );
    var wss = (
      /** @type {SchemeHandler} */
      {
        scheme: "wss",
        domainHost: ws.domainHost,
        parse: ws.parse,
        serialize: ws.serialize
      }
    );
    var urn = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn",
        parse: urnParse,
        serialize: urnSerialize,
        skipNormalize: true
      }
    );
    var urnuuid = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn:uuid",
        parse: urnuuidParse,
        serialize: urnuuidSerialize,
        skipNormalize: true
      }
    );
    var SCHEMES = (
      /** @type {Record<SchemeName, SchemeHandler>} */
      {
        http,
        https,
        ws,
        wss,
        urn,
        "urn:uuid": urnuuid
      }
    );
    Object.setPrototypeOf(SCHEMES, null);
    function getSchemeHandler(scheme) {
      return scheme && (SCHEMES[
        /** @type {SchemeName} */
        scheme
      ] || SCHEMES[
        /** @type {SchemeName} */
        scheme.toLowerCase()
      ]) || void 0;
    }
    module2.exports = {
      wsIsSecure,
      SCHEMES,
      isValidSchemeName,
      getSchemeHandler
    };
  }
});

// ../../node_modules/fast-uri/index.js
var require_fast_uri = __commonJS({
  "../../node_modules/fast-uri/index.js"(exports2, module2) {
    "use strict";
    var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, escapePreservingEscapes, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
    var { SCHEMES, getSchemeHandler } = require_schemes();
    function normalize(uri, options) {
      if (typeof uri === "string") {
        uri = /** @type {T} */
        normalizeString(uri, options);
      } else if (typeof uri === "object") {
        uri = /** @type {T} */
        parse(serialize(uri, options), options);
      }
      return uri;
    }
    function resolve4(baseURI, relativeURI, options) {
      const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
      const resolved = resolveComponent(parse(baseURI, schemelessOptions), parse(relativeURI, schemelessOptions), schemelessOptions, true);
      schemelessOptions.skipEscape = true;
      return serialize(resolved, schemelessOptions);
    }
    function resolveComponent(base, relative, options, skipNormalization) {
      const target = {};
      if (!skipNormalization) {
        base = parse(serialize(base, options), options);
        relative = parse(serialize(relative, options), options);
      }
      options = options || {};
      if (!options.tolerant && relative.scheme) {
        target.scheme = relative.scheme;
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (relative.userinfo !== void 0 || relative.host !== void 0 || relative.port !== void 0) {
          target.userinfo = relative.userinfo;
          target.host = relative.host;
          target.port = relative.port;
          target.path = removeDotSegments(relative.path || "");
          target.query = relative.query;
        } else {
          if (!relative.path) {
            target.path = base.path;
            if (relative.query !== void 0) {
              target.query = relative.query;
            } else {
              target.query = base.query;
            }
          } else {
            if (relative.path[0] === "/") {
              target.path = removeDotSegments(relative.path);
            } else {
              if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) {
                target.path = "/" + relative.path;
              } else if (!base.path) {
                target.path = relative.path;
              } else {
                target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
              }
              target.path = removeDotSegments(target.path);
            }
            target.query = relative.query;
          }
          target.userinfo = base.userinfo;
          target.host = base.host;
          target.port = base.port;
        }
        target.scheme = base.scheme;
      }
      target.fragment = relative.fragment;
      return target;
    }
    function equal(uriA, uriB, options) {
      const normalizedA = normalizeComparableURI(uriA, options);
      const normalizedB = normalizeComparableURI(uriB, options);
      return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA.toLowerCase() === normalizedB.toLowerCase();
    }
    function serialize(cmpts, opts) {
      const component = {
        host: cmpts.host,
        scheme: cmpts.scheme,
        userinfo: cmpts.userinfo,
        port: cmpts.port,
        path: cmpts.path,
        query: cmpts.query,
        nid: cmpts.nid,
        nss: cmpts.nss,
        uuid: cmpts.uuid,
        fragment: cmpts.fragment,
        reference: cmpts.reference,
        resourceName: cmpts.resourceName,
        secure: cmpts.secure,
        error: ""
      };
      const options = Object.assign({}, opts);
      const uriTokens = [];
      const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
      if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
      if (component.path !== void 0) {
        if (!options.skipEscape) {
          component.path = escapePreservingEscapes(component.path);
          if (component.scheme !== void 0) {
            component.path = component.path.split("%3A").join(":");
          }
        } else {
          component.path = normalizePercentEncoding(component.path);
        }
      }
      if (options.reference !== "suffix" && component.scheme) {
        uriTokens.push(component.scheme, ":");
      }
      const authority = recomposeAuthority(component);
      if (authority !== void 0) {
        if (options.reference !== "suffix") {
          uriTokens.push("//");
        }
        uriTokens.push(authority);
        if (component.path && component.path[0] !== "/") {
          uriTokens.push("/");
        }
      }
      if (component.path !== void 0) {
        let s = component.path;
        if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
          s = removeDotSegments(s);
        }
        if (authority === void 0 && s[0] === "/" && s[1] === "/") {
          s = "/%2F" + s.slice(2);
        }
        uriTokens.push(s);
      }
      if (component.query !== void 0) {
        uriTokens.push("?", component.query);
      }
      if (component.fragment !== void 0) {
        uriTokens.push("#", component.fragment);
      }
      return uriTokens.join("");
    }
    var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
    function getParseError(parsed, matches) {
      if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") {
        return 'URI path must start with "/" when authority is present.';
      }
      if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) {
        return "URI port is malformed.";
      }
      return void 0;
    }
    function parseWithStatus(uri, opts) {
      const options = Object.assign({}, opts);
      const parsed = {
        scheme: void 0,
        userinfo: void 0,
        host: "",
        port: void 0,
        path: "",
        query: void 0,
        fragment: void 0
      };
      let malformedAuthorityOrPort = false;
      let isIP = false;
      if (options.reference === "suffix") {
        if (options.scheme) {
          uri = options.scheme + ":" + uri;
        } else {
          uri = "//" + uri;
        }
      }
      const matches = uri.match(URI_PARSE);
      if (matches) {
        parsed.scheme = matches[1];
        parsed.userinfo = matches[3];
        parsed.host = matches[4];
        parsed.port = parseInt(matches[5], 10);
        parsed.path = matches[6] || "";
        parsed.query = matches[7];
        parsed.fragment = matches[8];
        if (isNaN(parsed.port)) {
          parsed.port = matches[5];
        }
        const parseError = getParseError(parsed, matches);
        if (parseError !== void 0) {
          parsed.error = parsed.error || parseError;
          malformedAuthorityOrPort = true;
        }
        if (parsed.host) {
          const ipv4result = isIPv4(parsed.host);
          if (ipv4result === false) {
            const ipv6result = normalizeIPv6(parsed.host);
            parsed.host = ipv6result.host.toLowerCase();
            isIP = ipv6result.isIPV6;
          } else {
            isIP = true;
          }
        }
        if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) {
          parsed.reference = "same-document";
        } else if (parsed.scheme === void 0) {
          parsed.reference = "relative";
        } else if (parsed.fragment === void 0) {
          parsed.reference = "absolute";
        } else {
          parsed.reference = "uri";
        }
        if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
          parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
        }
        const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
        if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
          if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) {
            try {
              parsed.host = new URL("http://" + parsed.host).hostname;
            } catch (e) {
              parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
            }
          }
        }
        if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
          if (uri.indexOf("%") !== -1) {
            if (parsed.scheme !== void 0) {
              parsed.scheme = unescape(parsed.scheme);
            }
            if (parsed.host !== void 0) {
              parsed.host = reescapeHostDelimiters(unescape(parsed.host), isIP);
            }
          }
          if (parsed.path) {
            parsed.path = normalizePathEncoding(parsed.path);
          }
          if (parsed.fragment) {
            try {
              parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
            } catch {
              parsed.error = parsed.error || "URI malformed";
            }
          }
        }
        if (schemeHandler && schemeHandler.parse) {
          schemeHandler.parse(parsed, options);
        }
      } else {
        parsed.error = parsed.error || "URI can not be parsed.";
      }
      return { parsed, malformedAuthorityOrPort };
    }
    function parse(uri, opts) {
      return parseWithStatus(uri, opts).parsed;
    }
    function normalizeString(uri, opts) {
      return normalizeStringWithStatus(uri, opts).normalized;
    }
    function normalizeStringWithStatus(uri, opts) {
      const { parsed, malformedAuthorityOrPort } = parseWithStatus(uri, opts);
      return {
        normalized: malformedAuthorityOrPort ? uri : serialize(parsed, opts),
        malformedAuthorityOrPort
      };
    }
    function normalizeComparableURI(uri, opts) {
      if (typeof uri === "string") {
        const { normalized, malformedAuthorityOrPort } = normalizeStringWithStatus(uri, opts);
        return malformedAuthorityOrPort ? void 0 : normalized;
      }
      if (typeof uri === "object") {
        return serialize(uri, opts);
      }
    }
    var fastUri = {
      SCHEMES,
      normalize,
      resolve: resolve4,
      resolveComponent,
      equal,
      serialize,
      parse
    };
    module2.exports = fastUri;
    module2.exports.default = fastUri;
    module2.exports.fastUri = fastUri;
  }
});

// ../../node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS({
  "../../node_modules/ajv/dist/runtime/uri.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var uri = require_fast_uri();
    uri.code = 'require("ajv/dist/runtime/uri").default';
    exports2.default = uri;
  }
});

// ../../node_modules/ajv/dist/core.js
var require_core = __commonJS({
  "../../node_modules/ajv/dist/core.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CodeGen = exports2.Name = exports2.nil = exports2.stringify = exports2.str = exports2._ = exports2.KeywordCxt = void 0;
    var validate_1 = require_validate();
    Object.defineProperty(exports2, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports2, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports2, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports2, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports2, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports2, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports2, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    var ref_error_1 = require_ref_error();
    var rules_1 = require_rules();
    var compile_1 = require_compile();
    var codegen_2 = require_codegen();
    var resolve_1 = require_resolve();
    var dataType_1 = require_dataType();
    var util_1 = require_util();
    var $dataRefSchema = require_data();
    var uri_1 = require_uri();
    var defaultRegExp = (str, flags) => new RegExp(str, flags);
    defaultRegExp.code = "new RegExp";
    var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
    var EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
      "validate",
      "serialize",
      "parse",
      "wrapper",
      "root",
      "schema",
      "keyword",
      "pattern",
      "formats",
      "validate$data",
      "func",
      "obj",
      "Error"
    ]);
    var removedOptions = {
      errorDataPath: "",
      format: "`validateFormats: false` can be used instead.",
      nullable: '"nullable" keyword is supported by default.',
      jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
      extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
      missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
      processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
      sourceCode: "Use option `code: {source: true}`",
      strictDefaults: "It is default now, see option `strict`.",
      strictKeywords: "It is default now, see option `strict`.",
      uniqueItems: '"uniqueItems" keyword is always validated.',
      unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
      cache: "Map is used as cache, schema object as key.",
      serialize: "Map is used as cache, schema object as key.",
      ajvErrors: "It is default now."
    };
    var deprecatedOptions = {
      ignoreKeywordsWithRef: "",
      jsPropertySyntax: "",
      unicode: '"minLength"/"maxLength" account for unicode characters by default.'
    };
    var MAX_EXPRESSION = 200;
    function requiredOptions(o) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
      const s = o.strict;
      const _optz = (_a = o.code) === null || _a === void 0 ? void 0 : _a.optimize;
      const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
      const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
      const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
      return {
        strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
        strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
        strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
        strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
        strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
        code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
        loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
        loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
        meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
        messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
        inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
        schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
        addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
        validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
        validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
        unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
        int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
        uriResolver
      };
    }
    var Ajv3 = class {
      constructor(opts = {}) {
        this.schemas = {};
        this.refs = {};
        this.formats = /* @__PURE__ */ Object.create(null);
        this._compilations = /* @__PURE__ */ new Set();
        this._loading = {};
        this._cache = /* @__PURE__ */ new Map();
        opts = this.opts = { ...opts, ...requiredOptions(opts) };
        const { es5, lines } = this.opts.code;
        this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
        this.logger = getLogger2(opts.logger);
        const formatOpt = opts.validateFormats;
        opts.validateFormats = false;
        this.RULES = (0, rules_1.getRules)();
        checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
        checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
        this._metaOpts = getMetaSchemaOptions.call(this);
        if (opts.formats)
          addInitialFormats.call(this);
        this._addVocabularies();
        this._addDefaultMetaSchema();
        if (opts.keywords)
          addInitialKeywords.call(this, opts.keywords);
        if (typeof opts.meta == "object")
          this.addMetaSchema(opts.meta);
        addInitialSchemas.call(this);
        opts.validateFormats = formatOpt;
      }
      _addVocabularies() {
        this.addKeyword("$async");
      }
      _addDefaultMetaSchema() {
        const { $data, meta, schemaId } = this.opts;
        let _dataRefSchema = $dataRefSchema;
        if (schemaId === "id") {
          _dataRefSchema = { ...$dataRefSchema };
          _dataRefSchema.id = _dataRefSchema.$id;
          delete _dataRefSchema.$id;
        }
        if (meta && $data)
          this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
      }
      defaultMeta() {
        const { meta, schemaId } = this.opts;
        return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : void 0;
      }
      validate(schemaKeyRef, data) {
        let v;
        if (typeof schemaKeyRef == "string") {
          v = this.getSchema(schemaKeyRef);
          if (!v)
            throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
        } else {
          v = this.compile(schemaKeyRef);
        }
        const valid = v(data);
        if (!("$async" in v))
          this.errors = v.errors;
        return valid;
      }
      compile(schema, _meta) {
        const sch = this._addSchema(schema, _meta);
        return sch.validate || this._compileSchemaEnv(sch);
      }
      compileAsync(schema, meta) {
        if (typeof this.opts.loadSchema != "function") {
          throw new Error("options.loadSchema should be a function");
        }
        const { loadSchema } = this.opts;
        return runCompileAsync.call(this, schema, meta);
        async function runCompileAsync(_schema, _meta) {
          await loadMetaSchema.call(this, _schema.$schema);
          const sch = this._addSchema(_schema, _meta);
          return sch.validate || _compileAsync.call(this, sch);
        }
        async function loadMetaSchema($ref) {
          if ($ref && !this.getSchema($ref)) {
            await runCompileAsync.call(this, { $ref }, true);
          }
        }
        async function _compileAsync(sch) {
          try {
            return this._compileSchemaEnv(sch);
          } catch (e) {
            if (!(e instanceof ref_error_1.default))
              throw e;
            checkLoaded.call(this, e);
            await loadMissingSchema.call(this, e.missingSchema);
            return _compileAsync.call(this, sch);
          }
        }
        function checkLoaded({ missingSchema: ref, missingRef }) {
          if (this.refs[ref]) {
            throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
          }
        }
        async function loadMissingSchema(ref) {
          const _schema = await _loadSchema.call(this, ref);
          if (!this.refs[ref])
            await loadMetaSchema.call(this, _schema.$schema);
          if (!this.refs[ref])
            this.addSchema(_schema, ref, meta);
        }
        async function _loadSchema(ref) {
          const p = this._loading[ref];
          if (p)
            return p;
          try {
            return await (this._loading[ref] = loadSchema(ref));
          } finally {
            delete this._loading[ref];
          }
        }
      }
      // Adds schema to the instance
      addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
        if (Array.isArray(schema)) {
          for (const sch of schema)
            this.addSchema(sch, void 0, _meta, _validateSchema);
          return this;
        }
        let id;
        if (typeof schema === "object") {
          const { schemaId } = this.opts;
          id = schema[schemaId];
          if (id !== void 0 && typeof id != "string") {
            throw new Error(`schema ${schemaId} must be string`);
          }
        }
        key = (0, resolve_1.normalizeId)(key || id);
        this._checkUnique(key);
        this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
        return this;
      }
      // Add schema that will be used to validate other schemas
      // options in META_IGNORE_OPTIONS are alway set to false
      addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
        this.addSchema(schema, key, true, _validateSchema);
        return this;
      }
      //  Validate schema against its meta-schema
      validateSchema(schema, throwOrLogError) {
        if (typeof schema == "boolean")
          return true;
        let $schema;
        $schema = schema.$schema;
        if ($schema !== void 0 && typeof $schema != "string") {
          throw new Error("$schema must be a string");
        }
        $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
        if (!$schema) {
          this.logger.warn("meta-schema not available");
          this.errors = null;
          return true;
        }
        const valid = this.validate($schema, schema);
        if (!valid && throwOrLogError) {
          const message = "schema is invalid: " + this.errorsText();
          if (this.opts.validateSchema === "log")
            this.logger.error(message);
          else
            throw new Error(message);
        }
        return valid;
      }
      // Get compiled schema by `key` or `ref`.
      // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
      getSchema(keyRef) {
        let sch;
        while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
          keyRef = sch;
        if (sch === void 0) {
          const { schemaId } = this.opts;
          const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
          sch = compile_1.resolveSchema.call(this, root, keyRef);
          if (!sch)
            return;
          this.refs[keyRef] = sch;
        }
        return sch.validate || this._compileSchemaEnv(sch);
      }
      // Remove cached schema(s).
      // If no parameter is passed all schemas but meta-schemas are removed.
      // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
      // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
      removeSchema(schemaKeyRef) {
        if (schemaKeyRef instanceof RegExp) {
          this._removeAllSchemas(this.schemas, schemaKeyRef);
          this._removeAllSchemas(this.refs, schemaKeyRef);
          return this;
        }
        switch (typeof schemaKeyRef) {
          case "undefined":
            this._removeAllSchemas(this.schemas);
            this._removeAllSchemas(this.refs);
            this._cache.clear();
            return this;
          case "string": {
            const sch = getSchEnv.call(this, schemaKeyRef);
            if (typeof sch == "object")
              this._cache.delete(sch.schema);
            delete this.schemas[schemaKeyRef];
            delete this.refs[schemaKeyRef];
            return this;
          }
          case "object": {
            const cacheKey = schemaKeyRef;
            this._cache.delete(cacheKey);
            let id = schemaKeyRef[this.opts.schemaId];
            if (id) {
              id = (0, resolve_1.normalizeId)(id);
              delete this.schemas[id];
              delete this.refs[id];
            }
            return this;
          }
          default:
            throw new Error("ajv.removeSchema: invalid parameter");
        }
      }
      // add "vocabulary" - a collection of keywords
      addVocabulary(definitions) {
        for (const def of definitions)
          this.addKeyword(def);
        return this;
      }
      addKeyword(kwdOrDef, def) {
        let keyword;
        if (typeof kwdOrDef == "string") {
          keyword = kwdOrDef;
          if (typeof def == "object") {
            this.logger.warn("these parameters are deprecated, see docs for addKeyword");
            def.keyword = keyword;
          }
        } else if (typeof kwdOrDef == "object" && def === void 0) {
          def = kwdOrDef;
          keyword = def.keyword;
          if (Array.isArray(keyword) && !keyword.length) {
            throw new Error("addKeywords: keyword must be string or non-empty array");
          }
        } else {
          throw new Error("invalid addKeywords parameters");
        }
        checkKeyword.call(this, keyword, def);
        if (!def) {
          (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
          return this;
        }
        keywordMetaschema.call(this, def);
        const definition = {
          ...def,
          type: (0, dataType_1.getJSONTypes)(def.type),
          schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
        };
        (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
        return this;
      }
      getKeyword(keyword) {
        const rule = this.RULES.all[keyword];
        return typeof rule == "object" ? rule.definition : !!rule;
      }
      // Remove keyword
      removeKeyword(keyword) {
        const { RULES } = this;
        delete RULES.keywords[keyword];
        delete RULES.all[keyword];
        for (const group of RULES.rules) {
          const i = group.rules.findIndex((rule) => rule.keyword === keyword);
          if (i >= 0)
            group.rules.splice(i, 1);
        }
        return this;
      }
      // Add format
      addFormat(name, format) {
        if (typeof format == "string")
          format = new RegExp(format);
        this.formats[name] = format;
        return this;
      }
      errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
        if (!errors || errors.length === 0)
          return "No errors";
        return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
      }
      $dataMetaSchema(metaSchema, keywordsJsonPointers) {
        const rules = this.RULES.all;
        metaSchema = JSON.parse(JSON.stringify(metaSchema));
        for (const jsonPointer of keywordsJsonPointers) {
          const segments = jsonPointer.split("/").slice(1);
          let keywords = metaSchema;
          for (const seg of segments)
            keywords = keywords[seg];
          for (const key in rules) {
            const rule = rules[key];
            if (typeof rule != "object")
              continue;
            const { $data } = rule.definition;
            const schema = keywords[key];
            if ($data && schema)
              keywords[key] = schemaOrData(schema);
          }
        }
        return metaSchema;
      }
      _removeAllSchemas(schemas, regex) {
        for (const keyRef in schemas) {
          const sch = schemas[keyRef];
          if (!regex || regex.test(keyRef)) {
            if (typeof sch == "string") {
              delete schemas[keyRef];
            } else if (sch && !sch.meta) {
              this._cache.delete(sch.schema);
              delete schemas[keyRef];
            }
          }
        }
      }
      _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
        let id;
        const { schemaId } = this.opts;
        if (typeof schema == "object") {
          id = schema[schemaId];
        } else {
          if (this.opts.jtd)
            throw new Error("schema must be object");
          else if (typeof schema != "boolean")
            throw new Error("schema must be object or boolean");
        }
        let sch = this._cache.get(schema);
        if (sch !== void 0)
          return sch;
        baseId = (0, resolve_1.normalizeId)(id || baseId);
        const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
        sch = new compile_1.SchemaEnv({ schema, schemaId, meta, baseId, localRefs });
        this._cache.set(sch.schema, sch);
        if (addSchema && !baseId.startsWith("#")) {
          if (baseId)
            this._checkUnique(baseId);
          this.refs[baseId] = sch;
        }
        if (validateSchema)
          this.validateSchema(schema, true);
        return sch;
      }
      _checkUnique(id) {
        if (this.schemas[id] || this.refs[id]) {
          throw new Error(`schema with key or id "${id}" already exists`);
        }
      }
      _compileSchemaEnv(sch) {
        if (sch.meta)
          this._compileMetaSchema(sch);
        else
          compile_1.compileSchema.call(this, sch);
        if (!sch.validate)
          throw new Error("ajv implementation error");
        return sch.validate;
      }
      _compileMetaSchema(sch) {
        const currentOpts = this.opts;
        this.opts = this._metaOpts;
        try {
          compile_1.compileSchema.call(this, sch);
        } finally {
          this.opts = currentOpts;
        }
      }
    };
    Ajv3.ValidationError = validation_error_1.default;
    Ajv3.MissingRefError = ref_error_1.default;
    exports2.default = Ajv3;
    function checkOptions(checkOpts, options, msg, log = "error") {
      for (const key in checkOpts) {
        const opt = key;
        if (opt in options)
          this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
      }
    }
    function getSchEnv(keyRef) {
      keyRef = (0, resolve_1.normalizeId)(keyRef);
      return this.schemas[keyRef] || this.refs[keyRef];
    }
    function addInitialSchemas() {
      const optsSchemas = this.opts.schemas;
      if (!optsSchemas)
        return;
      if (Array.isArray(optsSchemas))
        this.addSchema(optsSchemas);
      else
        for (const key in optsSchemas)
          this.addSchema(optsSchemas[key], key);
    }
    function addInitialFormats() {
      for (const name in this.opts.formats) {
        const format = this.opts.formats[name];
        if (format)
          this.addFormat(name, format);
      }
    }
    function addInitialKeywords(defs) {
      if (Array.isArray(defs)) {
        this.addVocabulary(defs);
        return;
      }
      this.logger.warn("keywords option as map is deprecated, pass array");
      for (const keyword in defs) {
        const def = defs[keyword];
        if (!def.keyword)
          def.keyword = keyword;
        this.addKeyword(def);
      }
    }
    function getMetaSchemaOptions() {
      const metaOpts = { ...this.opts };
      for (const opt of META_IGNORE_OPTIONS)
        delete metaOpts[opt];
      return metaOpts;
    }
    var noLogs = { log() {
    }, warn() {
    }, error() {
    } };
    function getLogger2(logger16) {
      if (logger16 === false)
        return noLogs;
      if (logger16 === void 0)
        return console;
      if (logger16.log && logger16.warn && logger16.error)
        return logger16;
      throw new Error("logger must implement log, warn and error methods");
    }
    var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
    function checkKeyword(keyword, def) {
      const { RULES } = this;
      (0, util_1.eachItem)(keyword, (kwd) => {
        if (RULES.keywords[kwd])
          throw new Error(`Keyword ${kwd} is already defined`);
        if (!KEYWORD_NAME.test(kwd))
          throw new Error(`Keyword ${kwd} has invalid name`);
      });
      if (!def)
        return;
      if (def.$data && !("code" in def || "validate" in def)) {
        throw new Error('$data keyword must have "code" or "validate" function');
      }
    }
    function addRule(keyword, definition, dataType) {
      var _a;
      const post = definition === null || definition === void 0 ? void 0 : definition.post;
      if (dataType && post)
        throw new Error('keyword with "post" flag cannot have "type"');
      const { RULES } = this;
      let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
      if (!ruleGroup) {
        ruleGroup = { type: dataType, rules: [] };
        RULES.rules.push(ruleGroup);
      }
      RULES.keywords[keyword] = true;
      if (!definition)
        return;
      const rule = {
        keyword,
        definition: {
          ...definition,
          type: (0, dataType_1.getJSONTypes)(definition.type),
          schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
        }
      };
      if (definition.before)
        addBeforeRule.call(this, ruleGroup, rule, definition.before);
      else
        ruleGroup.rules.push(rule);
      RULES.all[keyword] = rule;
      (_a = definition.implements) === null || _a === void 0 ? void 0 : _a.forEach((kwd) => this.addKeyword(kwd));
    }
    function addBeforeRule(ruleGroup, rule, before) {
      const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
      if (i >= 0) {
        ruleGroup.rules.splice(i, 0, rule);
      } else {
        ruleGroup.rules.push(rule);
        this.logger.warn(`rule ${before} is not defined`);
      }
    }
    function keywordMetaschema(def) {
      let { metaSchema } = def;
      if (metaSchema === void 0)
        return;
      if (def.$data && this.opts.$data)
        metaSchema = schemaOrData(metaSchema);
      def.validateSchema = this.compile(metaSchema, true);
    }
    var $dataRef = {
      $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
    };
    function schemaOrData(schema) {
      return { anyOf: [schema, $dataRef] };
    }
  }
});

// ../../node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/core/id.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var def = {
      keyword: "id",
      code() {
        throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/core/ref.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.callRef = exports2.getValidate = void 0;
    var ref_error_1 = require_ref_error();
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var util_1 = require_util();
    var def = {
      keyword: "$ref",
      schemaType: "string",
      code(cxt) {
        const { gen, schema: $ref, it } = cxt;
        const { baseId, schemaEnv: env, validateName, opts, self } = it;
        const { root } = env;
        if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
          return callRootRef();
        const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
        if (schOrEnv === void 0)
          throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
        if (schOrEnv instanceof compile_1.SchemaEnv)
          return callValidate(schOrEnv);
        return inlineRefSchema(schOrEnv);
        function callRootRef() {
          if (env === root)
            return callRef(cxt, validateName, env, env.$async);
          const rootName = gen.scopeValue("root", { ref: root });
          return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
        }
        function callValidate(sch) {
          const v = getValidate(cxt, sch);
          callRef(cxt, v, sch, sch.$async);
        }
        function inlineRefSchema(sch) {
          const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
          const valid = gen.name("valid");
          const schCxt = cxt.subschema({
            schema: sch,
            dataTypes: [],
            schemaPath: codegen_1.nil,
            topSchemaRef: schName,
            errSchemaPath: $ref
          }, valid);
          cxt.mergeEvaluated(schCxt);
          cxt.ok(valid);
        }
      }
    };
    function getValidate(cxt, sch) {
      const { gen } = cxt;
      return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
    }
    exports2.getValidate = getValidate;
    function callRef(cxt, v, sch, $async) {
      const { gen, it } = cxt;
      const { allErrors, schemaEnv: env, opts } = it;
      const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
      if ($async)
        callAsyncRef();
      else
        callSyncRef();
      function callAsyncRef() {
        if (!env.$async)
          throw new Error("async schema referenced by sync schema");
        const valid = gen.let("valid");
        gen.try(() => {
          gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
          addEvaluatedFrom(v);
          if (!allErrors)
            gen.assign(valid, true);
        }, (e) => {
          gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
          addErrorsFrom(e);
          if (!allErrors)
            gen.assign(valid, false);
        });
        cxt.ok(valid);
      }
      function callSyncRef() {
        cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
      }
      function addErrorsFrom(source) {
        const errs = (0, codegen_1._)`${source}.errors`;
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
        gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      }
      function addEvaluatedFrom(source) {
        var _a;
        if (!it.opts.unevaluated)
          return;
        const schEvaluated = (_a = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a === void 0 ? void 0 : _a.evaluated;
        if (it.props !== true) {
          if (schEvaluated && !schEvaluated.dynamicProps) {
            if (schEvaluated.props !== void 0) {
              it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
            }
          } else {
            const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
            it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
          }
        }
        if (it.items !== true) {
          if (schEvaluated && !schEvaluated.dynamicItems) {
            if (schEvaluated.items !== void 0) {
              it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
            }
          } else {
            const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
            it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
          }
        }
      }
    }
    exports2.callRef = callRef;
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/core/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var id_1 = require_id();
    var ref_1 = require_ref();
    var core = [
      "$schema",
      "$id",
      "$defs",
      "$vocabulary",
      { keyword: "$comment" },
      "definitions",
      id_1.default,
      ref_1.default
    ];
    exports2.default = core;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/limitNumber.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    var def = {
      keyword: Object.keys(KWDs),
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/multipleOf.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    };
    var def = {
      keyword: "multipleOf",
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, schemaCode, it } = cxt;
        const prec = it.opts.multipleOfPrecision;
        const res = gen.let("res");
        const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
        cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "../../node_modules/ajv/dist/runtime/ucs2length.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports2.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/limitLength.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var ucs2length_1 = require_ucs2length();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxLength", "minLength"],
      type: "string",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode, it } = cxt;
        const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
        const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
        cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/pattern.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var code_1 = require_code2();
    var util_1 = require_util();
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    };
    var def = {
      keyword: "pattern",
      type: "string",
      schemaType: "string",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const u = it.opts.unicodeRegExp ? "u" : "";
        if ($data) {
          const { regExp } = it.opts.code;
          const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
          const valid = gen.let("valid");
          gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
          cxt.fail$data((0, codegen_1._)`!${valid}`);
        } else {
          const regExp = (0, code_1.usePattern)(cxt, schema);
          cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/limitProperties.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxProperties", "minProperties"],
      type: "object",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/required.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    };
    var def = {
      keyword: "required",
      type: "object",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, schema, schemaCode, data, $data, it } = cxt;
        const { opts } = it;
        if (!$data && schema.length === 0)
          return;
        const useLoop = schema.length >= opts.loopRequired;
        if (it.allErrors)
          allErrorsMode();
        else
          exitOnErrorMode();
        if (opts.strictRequired) {
          const props = cxt.parentSchema.properties;
          const { definedProperties } = cxt.it;
          for (const requiredKey of schema) {
            if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
              const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
              const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
              (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
            }
          }
        }
        function allErrorsMode() {
          if (useLoop || $data) {
            cxt.block$data(codegen_1.nil, loopAllRequired);
          } else {
            for (const prop of schema) {
              (0, code_1.checkReportMissingProp)(cxt, prop);
            }
          }
        }
        function exitOnErrorMode() {
          const missing = gen.let("missing");
          if (useLoop || $data) {
            const valid = gen.let("valid", true);
            cxt.block$data(valid, () => loopUntilMissing(missing, valid));
            cxt.ok(valid);
          } else {
            gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
            (0, code_1.reportMissingProp)(cxt, missing);
            gen.else();
          }
        }
        function loopAllRequired() {
          gen.forOf("prop", schemaCode, (prop) => {
            cxt.setParams({ missingProperty: prop });
            gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
          });
        }
        function loopUntilMissing(missing, valid) {
          cxt.setParams({ missingProperty: missing });
          gen.forOf(missing, schemaCode, () => {
            gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.error();
              gen.break();
            });
          }, codegen_1.nil);
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/limitItems.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxItems", "minItems"],
      type: "array",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "../../node_modules/ajv/dist/runtime/equal.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports2.default = equal;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/uniqueItems.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var dataType_1 = require_dataType();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    };
    var def = {
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
        if (!$data && !schema)
          return;
        const valid = gen.let("valid");
        const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
        cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
        cxt.ok(valid);
        function validateUniqueItems() {
          const i = gen.let("i", (0, codegen_1._)`${data}.length`);
          const j = gen.let("j");
          cxt.setParams({ i, j });
          gen.assign(valid, true);
          gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
        }
        function canOptimize() {
          return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
        }
        function loopN(i, j) {
          const item = gen.name("item");
          const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
          const indices = gen.const("indices", (0, codegen_1._)`{}`);
          gen.for((0, codegen_1._)`;${i}--;`, () => {
            gen.let(item, (0, codegen_1._)`${data}[${i}]`);
            gen.if(wrongType, (0, codegen_1._)`continue`);
            if (itemTypes.length > 1)
              gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
            gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
              gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
              cxt.error();
              gen.assign(valid, false).break();
            }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
          });
        }
        function loopN2(i, j) {
          const eql = (0, util_1.useFunc)(gen, equal_1.default);
          const outer = gen.name("outer");
          gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          })));
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/const.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    };
    var def = {
      keyword: "const",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schemaCode, schema } = cxt;
        if ($data || schema && typeof schema == "object") {
          cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
        } else {
          cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/enum.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    };
    var def = {
      keyword: "enum",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        if (!$data && schema.length === 0)
          throw new Error("enum must have non-empty array");
        const useLoop = schema.length >= it.opts.loopEnum;
        let eql;
        const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
        let valid;
        if (useLoop || $data) {
          valid = gen.let("valid");
          cxt.block$data(valid, loopEnum);
        } else {
          if (!Array.isArray(schema))
            throw new Error("ajv implementation error");
          const vSchema = gen.const("vSchema", schemaCode);
          valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
        }
        cxt.pass(valid);
        function loopEnum() {
          gen.assign(valid, false);
          gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
        }
        function equalCode(vSchema, i) {
          const sch = schema[i];
          return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/validation/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var limitNumber_1 = require_limitNumber();
    var multipleOf_1 = require_multipleOf();
    var limitLength_1 = require_limitLength();
    var pattern_1 = require_pattern();
    var limitProperties_1 = require_limitProperties();
    var required_1 = require_required();
    var limitItems_1 = require_limitItems();
    var uniqueItems_1 = require_uniqueItems();
    var const_1 = require_const();
    var enum_1 = require_enum();
    var validation = [
      // number
      limitNumber_1.default,
      multipleOf_1.default,
      // string
      limitLength_1.default,
      pattern_1.default,
      // object
      limitProperties_1.default,
      required_1.default,
      // array
      limitItems_1.default,
      uniqueItems_1.default,
      // any
      { keyword: "type", schemaType: ["string", "array"] },
      { keyword: "nullable", schemaType: "boolean" },
      const_1.default,
      enum_1.default
    ];
    exports2.default = validation;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/additionalItems.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateAdditionalItems = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "additionalItems",
      type: "array",
      schemaType: ["boolean", "object"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { parentSchema, it } = cxt;
        const { items } = parentSchema;
        if (!Array.isArray(items)) {
          (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
          return;
        }
        validateAdditionalItems(cxt, items);
      }
    };
    function validateAdditionalItems(cxt, items) {
      const { gen, schema, data, keyword, it } = cxt;
      it.items = true;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items.length });
        cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
        cxt.ok(valid);
      }
      function validateItems(valid) {
        gen.forRange("i", items.length, len, (i) => {
          cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
    exports2.validateAdditionalItems = validateAdditionalItems;
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/items.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateTuple = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "array", "boolean"],
      before: "uniqueItems",
      code(cxt) {
        const { schema, it } = cxt;
        if (Array.isArray(schema))
          return validateTuple(cxt, "additionalItems", schema);
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    function validateTuple(cxt, extraItems, schArr = cxt.schema) {
      const { gen, parentSchema, data, keyword, it } = cxt;
      checkStrictTuple(parentSchema);
      if (it.opts.unevaluated && schArr.length && it.items !== true) {
        it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
      }
      const valid = gen.name("valid");
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      schArr.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
          keyword,
          schemaProp: i,
          dataProp: i
        }, valid));
        cxt.ok(valid);
      });
      function checkStrictTuple(sch) {
        const { opts, errSchemaPath } = it;
        const l = schArr.length;
        const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
        if (opts.strictTuples && !fullTuple) {
          const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
          (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
        }
      }
    }
    exports2.validateTuple = validateTuple;
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/prefixItems.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var items_1 = require_items();
    var def = {
      keyword: "prefixItems",
      type: "array",
      schemaType: ["array"],
      before: "uniqueItems",
      code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/items2020.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var additionalItems_1 = require_additionalItems();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { schema, parentSchema, it } = cxt;
        const { prefixItems } = parentSchema;
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        if (prefixItems)
          (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
        else
          cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/contains.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    };
    var def = {
      keyword: "contains",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        let min;
        let max;
        const { minContains, maxContains } = parentSchema;
        if (it.opts.next) {
          min = minContains === void 0 ? 1 : minContains;
          max = maxContains;
        } else {
          min = 1;
        }
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        cxt.setParams({ min, max });
        if (max === void 0 && min === 0) {
          (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
          return;
        }
        if (max !== void 0 && min > max) {
          (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
          cxt.fail();
          return;
        }
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          let cond = (0, codegen_1._)`${len} >= ${min}`;
          if (max !== void 0)
            cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
          cxt.pass(cond);
          return;
        }
        it.items = true;
        const valid = gen.name("valid");
        if (max === void 0 && min === 1) {
          validateItems(valid, () => gen.if(valid, () => gen.break()));
        } else if (min === 0) {
          gen.let(valid, true);
          if (max !== void 0)
            gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
        } else {
          gen.let(valid, false);
          validateItemsWithCount();
        }
        cxt.result(valid, () => cxt.reset());
        function validateItemsWithCount() {
          const schValid = gen.name("_valid");
          const count = gen.let("count", 0);
          validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
        }
        function validateItems(_valid, block) {
          gen.forRange("i", 0, len, (i) => {
            cxt.subschema({
              keyword: "contains",
              dataProp: i,
              dataPropType: util_1.Type.Num,
              compositeRule: true
            }, _valid);
            block();
          });
        }
        function checkLimits(count) {
          gen.code((0, codegen_1._)`${count}++`);
          if (max === void 0) {
            gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
          } else {
            gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
            if (min === 1)
              gen.assign(valid, true);
            else
              gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
          }
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/dependencies.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.validateSchemaDeps = exports2.validatePropertyDeps = exports2.error = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    exports2.error = {
      message: ({ params: { property, depsCount, deps } }) => {
        const property_ies = depsCount === 1 ? "property" : "properties";
        return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
      },
      params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
      // TODO change to reference
    };
    var def = {
      keyword: "dependencies",
      type: "object",
      schemaType: "object",
      error: exports2.error,
      code(cxt) {
        const [propDeps, schDeps] = splitDependencies(cxt);
        validatePropertyDeps(cxt, propDeps);
        validateSchemaDeps(cxt, schDeps);
      }
    };
    function splitDependencies({ schema }) {
      const propertyDeps = {};
      const schemaDeps = {};
      for (const key in schema) {
        if (key === "__proto__")
          continue;
        const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
        deps[key] = schema[key];
      }
      return [propertyDeps, schemaDeps];
    }
    function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
      const { gen, data, it } = cxt;
      if (Object.keys(propertyDeps).length === 0)
        return;
      const missing = gen.let("missing");
      for (const prop in propertyDeps) {
        const deps = propertyDeps[prop];
        if (deps.length === 0)
          continue;
        const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
        cxt.setParams({
          property: prop,
          depsCount: deps.length,
          deps: deps.join(", ")
        });
        if (it.allErrors) {
          gen.if(hasProperty, () => {
            for (const depProp of deps) {
              (0, code_1.checkReportMissingProp)(cxt, depProp);
            }
          });
        } else {
          gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
    }
    exports2.validatePropertyDeps = validatePropertyDeps;
    function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      for (const prop in schemaDeps) {
        if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
          continue;
        gen.if(
          (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties),
          () => {
            const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
            cxt.mergeValidEvaluated(schCxt, valid);
          },
          () => gen.var(valid, true)
          // TODO var
        );
        cxt.ok(valid);
      }
    }
    exports2.validateSchemaDeps = validateSchemaDeps;
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/propertyNames.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    };
    var def = {
      keyword: "propertyNames",
      type: "object",
      schemaType: ["object", "boolean"],
      error,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        const valid = gen.name("valid");
        gen.forIn("key", data, (key) => {
          cxt.setParams({ propertyName: key });
          cxt.subschema({
            keyword: "propertyNames",
            data: key,
            dataTypes: ["string"],
            propertyName: key,
            compositeRule: true
          }, valid);
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error(true);
            if (!it.allErrors)
              gen.break();
          });
        });
        cxt.ok(valid);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var util_1 = require_util();
    var error = {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    };
    var def = {
      keyword: "additionalProperties",
      type: ["object"],
      schemaType: ["boolean", "object"],
      allowUndefined: true,
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, opts } = it;
        it.props = true;
        if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
          return;
        const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
        const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
        checkAdditionalProperties();
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function checkAdditionalProperties() {
          gen.forIn("key", data, (key) => {
            if (!props.length && !patProps.length)
              additionalPropertyCode(key);
            else
              gen.if(isAdditional(key), () => additionalPropertyCode(key));
          });
        }
        function isAdditional(key) {
          let definedProp;
          if (props.length > 8) {
            const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
            definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
          } else if (props.length) {
            definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
          } else {
            definedProp = codegen_1.nil;
          }
          if (patProps.length) {
            definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
          }
          return (0, codegen_1.not)(definedProp);
        }
        function deleteAdditional(key) {
          gen.code((0, codegen_1._)`delete ${data}[${key}]`);
        }
        function additionalPropertyCode(key) {
          if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
            deleteAdditional(key);
            return;
          }
          if (schema === false) {
            cxt.setParams({ additionalProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            if (opts.removeAdditional === "failing") {
              applyAdditionalSchema(key, valid, false);
              gen.if((0, codegen_1.not)(valid), () => {
                cxt.reset();
                deleteAdditional(key);
              });
            } else {
              applyAdditionalSchema(key, valid);
              if (!allErrors)
                gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          }
        }
        function applyAdditionalSchema(key, valid, errors) {
          const subschema = {
            keyword: "additionalProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          };
          if (errors === false) {
            Object.assign(subschema, {
              compositeRule: true,
              createErrors: false,
              allErrors: false
            });
          }
          cxt.subschema(subschema, valid);
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/properties.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var validate_1 = require_validate();
    var code_1 = require_code2();
    var util_1 = require_util();
    var additionalProperties_1 = require_additionalProperties();
    var def = {
      keyword: "properties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) {
          additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
        }
        const allProps = (0, code_1.allSchemaProperties)(schema);
        for (const prop of allProps) {
          it.definedProperties.add(prop);
        }
        if (it.opts.unevaluated && allProps.length && it.props !== true) {
          it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
        }
        const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
        if (properties.length === 0)
          return;
        const valid = gen.name("valid");
        for (const prop of properties) {
          if (hasDefault(prop)) {
            applyPropertySchema(prop);
          } else {
            gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
            applyPropertySchema(prop);
            if (!it.allErrors)
              gen.else().var(valid, true);
            gen.endIf();
          }
          cxt.it.definedProperties.add(prop);
          cxt.ok(valid);
        }
        function hasDefault(prop) {
          return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
        }
        function applyPropertySchema(prop) {
          cxt.subschema({
            keyword: "properties",
            schemaProp: prop,
            dataProp: prop
          }, valid);
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/patternProperties.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var util_2 = require_util();
    var def = {
      keyword: "patternProperties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, data, parentSchema, it } = cxt;
        const { opts } = it;
        const patterns = (0, code_1.allSchemaProperties)(schema);
        const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
        if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
          return;
        }
        const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
        const valid = gen.name("valid");
        if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
          it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
        }
        const { props } = it;
        validatePatternProperties();
        function validatePatternProperties() {
          for (const pat of patterns) {
            if (checkProperties)
              checkMatchingProperties(pat);
            if (it.allErrors) {
              validateProperties(pat);
            } else {
              gen.var(valid, true);
              validateProperties(pat);
              gen.if(valid);
            }
          }
        }
        function checkMatchingProperties(pat) {
          for (const prop in checkProperties) {
            if (new RegExp(pat).test(prop)) {
              (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
            }
          }
        }
        function validateProperties(pat) {
          gen.forIn("key", data, (key) => {
            gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
              const alwaysValid = alwaysValidPatterns.includes(pat);
              if (!alwaysValid) {
                cxt.subschema({
                  keyword: "patternProperties",
                  schemaProp: pat,
                  dataProp: key,
                  dataPropType: util_2.Type.Str
                }, valid);
              }
              if (it.opts.unevaluated && props !== true) {
                gen.assign((0, codegen_1._)`${props}[${key}]`, true);
              } else if (!alwaysValid && !it.allErrors) {
                gen.if((0, codegen_1.not)(valid), () => gen.break());
              }
            });
          });
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/not.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "not",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      code(cxt) {
        const { gen, schema, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          cxt.fail();
          return;
        }
        const valid = gen.name("valid");
        cxt.subschema({
          keyword: "not",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, valid);
        cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
      },
      error: { message: "must NOT be valid" }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/anyOf.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var code_1 = require_code2();
    var def = {
      keyword: "anyOf",
      schemaType: "array",
      trackErrors: true,
      code: code_1.validateUnion,
      error: { message: "must match a schema in anyOf" }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/oneOf.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    };
    var def = {
      keyword: "oneOf",
      schemaType: "array",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        if (it.opts.discriminator && parentSchema.discriminator)
          return;
        const schArr = schema;
        const valid = gen.let("valid", false);
        const passing = gen.let("passing", null);
        const schValid = gen.name("_valid");
        cxt.setParams({ passing });
        gen.block(validateOneOf);
        cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
        function validateOneOf() {
          schArr.forEach((sch, i) => {
            let schCxt;
            if ((0, util_1.alwaysValidSchema)(it, sch)) {
              gen.var(schValid, true);
            } else {
              schCxt = cxt.subschema({
                keyword: "oneOf",
                schemaProp: i,
                compositeRule: true
              }, schValid);
            }
            if (i > 0) {
              gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
            }
            gen.if(schValid, () => {
              gen.assign(valid, true);
              gen.assign(passing, i);
              if (schCxt)
                cxt.mergeEvaluated(schCxt, codegen_1.Name);
            });
          });
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/allOf.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "allOf",
      schemaType: "array",
      code(cxt) {
        const { gen, schema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const valid = gen.name("valid");
        schema.forEach((sch, i) => {
          if ((0, util_1.alwaysValidSchema)(it, sch))
            return;
          const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
          cxt.ok(valid);
          cxt.mergeEvaluated(schCxt);
        });
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/if.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    };
    var def = {
      keyword: "if",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, parentSchema, it } = cxt;
        if (parentSchema.then === void 0 && parentSchema.else === void 0) {
          (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
        }
        const hasThen = hasSchema(it, "then");
        const hasElse = hasSchema(it, "else");
        if (!hasThen && !hasElse)
          return;
        const valid = gen.let("valid", true);
        const schValid = gen.name("_valid");
        validateIf();
        cxt.reset();
        if (hasThen && hasElse) {
          const ifClause = gen.let("ifClause");
          cxt.setParams({ ifClause });
          gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
        } else if (hasThen) {
          gen.if(schValid, validateClause("then"));
        } else {
          gen.if((0, codegen_1.not)(schValid), validateClause("else"));
        }
        cxt.pass(valid, () => cxt.error(true));
        function validateIf() {
          const schCxt = cxt.subschema({
            keyword: "if",
            compositeRule: true,
            createErrors: false,
            allErrors: false
          }, schValid);
          cxt.mergeEvaluated(schCxt);
        }
        function validateClause(keyword, ifClause) {
          return () => {
            const schCxt = cxt.subschema({ keyword }, schValid);
            gen.assign(valid, schValid);
            cxt.mergeValidEvaluated(schCxt, valid);
            if (ifClause)
              gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
            else
              cxt.setParams({ ifClause: keyword });
          };
        }
      }
    };
    function hasSchema(it, keyword) {
      const schema = it.schema[keyword];
      return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
    }
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/thenElse.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["then", "else"],
      schemaType: ["object", "boolean"],
      code({ keyword, parentSchema, it }) {
        if (parentSchema.if === void 0)
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/applicator/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var additionalItems_1 = require_additionalItems();
    var prefixItems_1 = require_prefixItems();
    var items_1 = require_items();
    var items2020_1 = require_items2020();
    var contains_1 = require_contains();
    var dependencies_1 = require_dependencies();
    var propertyNames_1 = require_propertyNames();
    var additionalProperties_1 = require_additionalProperties();
    var properties_1 = require_properties();
    var patternProperties_1 = require_patternProperties();
    var not_1 = require_not();
    var anyOf_1 = require_anyOf();
    var oneOf_1 = require_oneOf();
    var allOf_1 = require_allOf();
    var if_1 = require_if();
    var thenElse_1 = require_thenElse();
    function getApplicator(draft2020 = false) {
      const applicator = [
        // any
        not_1.default,
        anyOf_1.default,
        oneOf_1.default,
        allOf_1.default,
        if_1.default,
        thenElse_1.default,
        // object
        propertyNames_1.default,
        additionalProperties_1.default,
        dependencies_1.default,
        properties_1.default,
        patternProperties_1.default
      ];
      if (draft2020)
        applicator.push(prefixItems_1.default, items2020_1.default);
      else
        applicator.push(additionalItems_1.default, items_1.default);
      applicator.push(contains_1.default);
      return applicator;
    }
    exports2.default = getApplicator;
  }
});

// ../../node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/format/format.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    };
    var def = {
      keyword: "format",
      type: ["number", "string"],
      schemaType: "string",
      $data: true,
      error,
      code(cxt, ruleType) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const { opts, errSchemaPath, schemaEnv, self } = it;
        if (!opts.validateFormats)
          return;
        if ($data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
          const fType = gen.let("fType");
          const format = gen.let("format");
          gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
          cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
          function unknownFmt() {
            if (opts.strictSchema === false)
              return codegen_1.nil;
            return (0, codegen_1._)`${schemaCode} && !${format}`;
          }
          function invalidFmt() {
            const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
            const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
            return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
          }
        }
        function validateFormat() {
          const formatDef = self.formats[schema];
          if (!formatDef) {
            unknownFormat();
            return;
          }
          if (formatDef === true)
            return;
          const [fmtType, format, fmtRef] = getFormat(formatDef);
          if (fmtType === ruleType)
            cxt.pass(validCondition());
          function unknownFormat() {
            if (opts.strictSchema === false) {
              self.logger.warn(unknownMsg());
              return;
            }
            throw new Error(unknownMsg());
            function unknownMsg() {
              return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
            }
          }
          function getFormat(fmtDef) {
            const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
            const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
            if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
              return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
            }
            return ["string", fmtDef, fmt];
          }
          function validCondition() {
            if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
              if (!schemaEnv.$async)
                throw new Error("async format in sync schema");
              return (0, codegen_1._)`await ${fmtRef}(${data})`;
            }
            return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
          }
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/format/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var format_1 = require_format();
    var format = [format_1.default];
    exports2.default = format;
  }
});

// ../../node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/metadata.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.contentVocabulary = exports2.metadataVocabulary = void 0;
    exports2.metadataVocabulary = [
      "title",
      "description",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "examples"
    ];
    exports2.contentVocabulary = [
      "contentMediaType",
      "contentEncoding",
      "contentSchema"
    ];
  }
});

// ../../node_modules/ajv/dist/vocabularies/draft7.js
var require_draft7 = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/draft7.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var core_1 = require_core2();
    var validation_1 = require_validation();
    var applicator_1 = require_applicator();
    var format_1 = require_format2();
    var metadata_1 = require_metadata();
    var draft7Vocabularies = [
      core_1.default,
      validation_1.default,
      (0, applicator_1.default)(),
      format_1.default,
      metadata_1.metadataVocabulary,
      metadata_1.contentVocabulary
    ];
    exports2.default = draft7Vocabularies;
  }
});

// ../../node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/discriminator/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DiscrError = void 0;
    var DiscrError;
    (function(DiscrError2) {
      DiscrError2["Tag"] = "tag";
      DiscrError2["Mapping"] = "mapping";
    })(DiscrError || (exports2.DiscrError = DiscrError = {}));
  }
});

// ../../node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS({
  "../../node_modules/ajv/dist/vocabularies/discriminator/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var types_1 = require_types();
    var compile_1 = require_compile();
    var ref_error_1 = require_ref_error();
    var util_1 = require_util();
    var error = {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    };
    var def = {
      keyword: "discriminator",
      type: "object",
      schemaType: "object",
      error,
      code(cxt) {
        const { gen, data, schema, parentSchema, it } = cxt;
        const { oneOf } = parentSchema;
        if (!it.opts.discriminator) {
          throw new Error("discriminator: requires discriminator option");
        }
        const tagName = schema.propertyName;
        if (typeof tagName != "string")
          throw new Error("discriminator: requires propertyName");
        if (schema.mapping)
          throw new Error("discriminator: mapping is not supported");
        if (!oneOf)
          throw new Error("discriminator: requires oneOf keyword");
        const valid = gen.let("valid", false);
        const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
        gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag, tagName }));
        cxt.ok(valid);
        function validateMapping() {
          const mapping = getMapping();
          gen.if(false);
          for (const tagValue in mapping) {
            gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
            gen.assign(valid, applyTagSchema(mapping[tagValue]));
          }
          gen.else();
          cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag, tagName });
          gen.endIf();
        }
        function applyTagSchema(schemaProp) {
          const _valid = gen.name("valid");
          const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
          cxt.mergeEvaluated(schCxt, codegen_1.Name);
          return _valid;
        }
        function getMapping() {
          var _a;
          const oneOfMapping = {};
          const topRequired = hasRequired(parentSchema);
          let tagRequired = true;
          for (let i = 0; i < oneOf.length; i++) {
            let sch = oneOf[i];
            if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
              const ref = sch.$ref;
              sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
              if (sch instanceof compile_1.SchemaEnv)
                sch = sch.schema;
              if (sch === void 0)
                throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
            }
            const propSch = (_a = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a === void 0 ? void 0 : _a[tagName];
            if (typeof propSch != "object") {
              throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
            }
            tagRequired = tagRequired && (topRequired || hasRequired(sch));
            addMappings(propSch, i);
          }
          if (!tagRequired)
            throw new Error(`discriminator: "${tagName}" must be required`);
          return oneOfMapping;
          function hasRequired({ required }) {
            return Array.isArray(required) && required.includes(tagName);
          }
          function addMappings(sch, i) {
            if (sch.const) {
              addMapping(sch.const, i);
            } else if (sch.enum) {
              for (const tagValue of sch.enum) {
                addMapping(tagValue, i);
              }
            } else {
              throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
            }
          }
          function addMapping(tagValue, i) {
            if (typeof tagValue != "string" || tagValue in oneOfMapping) {
              throw new Error(`discriminator: "${tagName}" values must be unique strings`);
            }
            oneOfMapping[tagValue] = i;
          }
        }
      }
    };
    exports2.default = def;
  }
});

// ../../node_modules/ajv/dist/refs/json-schema-draft-07.json
var require_json_schema_draft_07 = __commonJS({
  "../../node_modules/ajv/dist/refs/json-schema-draft-07.json"(exports2, module2) {
    module2.exports = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "http://json-schema.org/draft-07/schema#",
      title: "Core schema meta-schema",
      definitions: {
        schemaArray: {
          type: "array",
          minItems: 1,
          items: { $ref: "#" }
        },
        nonNegativeInteger: {
          type: "integer",
          minimum: 0
        },
        nonNegativeIntegerDefault0: {
          allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }]
        },
        simpleTypes: {
          enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
        },
        stringArray: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          default: []
        }
      },
      type: ["object", "boolean"],
      properties: {
        $id: {
          type: "string",
          format: "uri-reference"
        },
        $schema: {
          type: "string",
          format: "uri"
        },
        $ref: {
          type: "string",
          format: "uri-reference"
        },
        $comment: {
          type: "string"
        },
        title: {
          type: "string"
        },
        description: {
          type: "string"
        },
        default: true,
        readOnly: {
          type: "boolean",
          default: false
        },
        examples: {
          type: "array",
          items: true
        },
        multipleOf: {
          type: "number",
          exclusiveMinimum: 0
        },
        maximum: {
          type: "number"
        },
        exclusiveMaximum: {
          type: "number"
        },
        minimum: {
          type: "number"
        },
        exclusiveMinimum: {
          type: "number"
        },
        maxLength: { $ref: "#/definitions/nonNegativeInteger" },
        minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        pattern: {
          type: "string",
          format: "regex"
        },
        additionalItems: { $ref: "#" },
        items: {
          anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }],
          default: true
        },
        maxItems: { $ref: "#/definitions/nonNegativeInteger" },
        minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        uniqueItems: {
          type: "boolean",
          default: false
        },
        contains: { $ref: "#" },
        maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
        minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        required: { $ref: "#/definitions/stringArray" },
        additionalProperties: { $ref: "#" },
        definitions: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        properties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        patternProperties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          propertyNames: { format: "regex" },
          default: {}
        },
        dependencies: {
          type: "object",
          additionalProperties: {
            anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }]
          }
        },
        propertyNames: { $ref: "#" },
        const: true,
        enum: {
          type: "array",
          items: true,
          minItems: 1,
          uniqueItems: true
        },
        type: {
          anyOf: [
            { $ref: "#/definitions/simpleTypes" },
            {
              type: "array",
              items: { $ref: "#/definitions/simpleTypes" },
              minItems: 1,
              uniqueItems: true
            }
          ]
        },
        format: { type: "string" },
        contentMediaType: { type: "string" },
        contentEncoding: { type: "string" },
        if: { $ref: "#" },
        then: { $ref: "#" },
        else: { $ref: "#" },
        allOf: { $ref: "#/definitions/schemaArray" },
        anyOf: { $ref: "#/definitions/schemaArray" },
        oneOf: { $ref: "#/definitions/schemaArray" },
        not: { $ref: "#" }
      },
      default: true
    };
  }
});

// ../../node_modules/ajv/dist/ajv.js
var require_ajv = __commonJS({
  "../../node_modules/ajv/dist/ajv.js"(exports2, module2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.MissingRefError = exports2.ValidationError = exports2.CodeGen = exports2.Name = exports2.nil = exports2.stringify = exports2.str = exports2._ = exports2.KeywordCxt = exports2.Ajv = void 0;
    var core_1 = require_core();
    var draft7_1 = require_draft7();
    var discriminator_1 = require_discriminator();
    var draft7MetaSchema = require_json_schema_draft_07();
    var META_SUPPORT_DATA = ["/properties"];
    var META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";
    var Ajv3 = class extends core_1.default {
      _addVocabularies() {
        super._addVocabularies();
        draft7_1.default.forEach((v) => this.addVocabulary(v));
        if (this.opts.discriminator)
          this.addKeyword(discriminator_1.default);
      }
      _addDefaultMetaSchema() {
        super._addDefaultMetaSchema();
        if (!this.opts.meta)
          return;
        const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
        this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
        this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
      }
      defaultMeta() {
        return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
      }
    };
    exports2.Ajv = Ajv3;
    module2.exports = exports2 = Ajv3;
    module2.exports.Ajv = Ajv3;
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.default = Ajv3;
    var validate_1 = require_validate();
    Object.defineProperty(exports2, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports2, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports2, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports2, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports2, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports2, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports2, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    Object.defineProperty(exports2, "ValidationError", { enumerable: true, get: function() {
      return validation_error_1.default;
    } });
    var ref_error_1 = require_ref_error();
    Object.defineProperty(exports2, "MissingRefError", { enumerable: true, get: function() {
      return ref_error_1.default;
    } });
  }
});

// ../../node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "../../node_modules/yaml/dist/nodes/identity.js"(exports2) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports2.ALIAS = ALIAS;
    exports2.DOC = DOC;
    exports2.MAP = MAP;
    exports2.NODE_TYPE = NODE_TYPE;
    exports2.PAIR = PAIR;
    exports2.SCALAR = SCALAR;
    exports2.SEQ = SEQ;
    exports2.hasAnchor = hasAnchor;
    exports2.isAlias = isAlias;
    exports2.isCollection = isCollection;
    exports2.isDocument = isDocument;
    exports2.isMap = isMap;
    exports2.isNode = isNode;
    exports2.isPair = isPair;
    exports2.isScalar = isScalar;
    exports2.isSeq = isSeq;
  }
});

// ../../node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "../../node_modules/yaml/dist/visit.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path8) {
      const ctrl = callVisitor(key, node, visitor, path8);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path8, ctrl);
        return visit_(key, ctrl, visitor, path8);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path8 = Object.freeze(path8.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path8);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path8 = Object.freeze(path8.concat(node));
          const ck = visit_("key", node.key, visitor, path8);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path8);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path8) {
      const ctrl = await callVisitor(key, node, visitor, path8);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path8, ctrl);
        return visitAsync_(key, ctrl, visitor, path8);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path8 = Object.freeze(path8.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path8);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path8 = Object.freeze(path8.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path8);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path8);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path8) {
      if (typeof visitor === "function")
        return visitor(key, node, path8);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path8);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path8);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path8);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path8);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path8);
      return void 0;
    }
    function replaceNode(key, path8, node) {
      const parent = path8[path8.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports2.visit = visit;
    exports2.visitAsync = visitAsync;
  }
});

// ../../node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "../../node_modules/yaml/dist/doc/directives.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports2.Directives = Directives;
  }
});

// ../../node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "../../node_modules/yaml/dist/doc/anchors.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports2.anchorIsValid = anchorIsValid;
    exports2.anchorNames = anchorNames;
    exports2.createNodeAnchors = createNodeAnchors;
    exports2.findNewAnchor = findNewAnchor;
  }
});

// ../../node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "../../node_modules/yaml/dist/doc/applyReviver.js"(exports2) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports2.applyReviver = applyReviver;
  }
});

// ../../node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "../../node_modules/yaml/dist/nodes/toJS.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports2.toJS = toJS;
  }
});

// ../../node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "../../node_modules/yaml/dist/nodes/Node.js"(exports2) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports2.NodeBase = NodeBase;
  }
});

// ../../node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "../../node_modules/yaml/dist/nodes/Alias.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports2.Alias = Alias;
  }
});

// ../../node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "../../node_modules/yaml/dist/nodes/Scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports2.Scalar = Scalar;
    exports2.isScalarValue = isScalarValue;
  }
});

// ../../node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "../../node_modules/yaml/dist/doc/createNode.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports2.createNode = createNode;
  }
});

// ../../node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "../../node_modules/yaml/dist/nodes/Collection.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path8, value) {
      let v = value;
      for (let i = path8.length - 1; i >= 0; --i) {
        const k = path8[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path8) => path8 == null || typeof path8 === "object" && !!path8[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path8, value) {
        if (isEmptyPath(path8))
          this.add(value);
        else {
          const [key, ...rest] = path8;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path8) {
        const [key, ...rest] = path8;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path8, keepScalar) {
        const [key, ...rest] = path8;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path8) {
        const [key, ...rest] = path8;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path8, value) {
        const [key, ...rest] = path8;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports2.Collection = Collection;
    exports2.collectionFromPath = collectionFromPath;
    exports2.isEmptyPath = isEmptyPath;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyComment.js"(exports2) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports2.indentComment = indentComment;
    exports2.lineComment = lineComment;
    exports2.stringifyComment = stringifyComment;
  }
});

// ../../node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "../../node_modules/yaml/dist/stringify/foldFlowLines.js"(exports2) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports2.FOLD_BLOCK = FOLD_BLOCK;
    exports2.FOLD_FLOW = FOLD_FLOW;
    exports2.FOLD_QUOTED = FOLD_QUOTED;
    exports2.foldFlowLines = foldFlowLines;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyString.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports2.stringifyString = stringifyString;
  }
});

// ../../node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringify.js"(exports2) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports2.createStringifyContext = createStringifyContext;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyPair.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports2.stringifyPair = stringifyPair;
  }
});

// ../../node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "../../node_modules/yaml/dist/log.js"(exports2) {
    "use strict";
    var node_process = require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports2.debug = debug;
    exports2.warn = warn;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports2.addMergeToJSMap = addMergeToJSMap;
    exports2.isMergeKey = isMergeKey;
    exports2.merge = merge;
  }
});

// ../../node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "../../node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports2) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports2.addPairToJSMap = addPairToJSMap;
  }
});

// ../../node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "../../node_modules/yaml/dist/nodes/Pair.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports2.Pair = Pair;
    exports2.createPair = createPair;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyCollection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports2.stringifyCollection = stringifyCollection;
  }
});

// ../../node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "../../node_modules/yaml/dist/nodes/YAMLMap.js"(exports2) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports2.YAMLMap = YAMLMap;
    exports2.findPair = findPair;
  }
});

// ../../node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "../../node_modules/yaml/dist/schema/common/map.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports2.map = map;
  }
});

// ../../node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "../../node_modules/yaml/dist/nodes/YAMLSeq.js"(exports2) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports2.YAMLSeq = YAMLSeq;
  }
});

// ../../node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "../../node_modules/yaml/dist/schema/common/seq.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports2.seq = seq;
  }
});

// ../../node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "../../node_modules/yaml/dist/schema/common/string.js"(exports2) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports2.string = string;
  }
});

// ../../node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "../../node_modules/yaml/dist/schema/common/null.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports2.nullTag = nullTag;
  }
});

// ../../node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "../../node_modules/yaml/dist/schema/core/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports2.boolTag = boolTag;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyNumber.js"(exports2) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports2.stringifyNumber = stringifyNumber;
  }
});

// ../../node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "../../node_modules/yaml/dist/schema/core/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "../../node_modules/yaml/dist/schema/core/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "../../node_modules/yaml/dist/schema/core/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "../../node_modules/yaml/dist/schema/json/schema.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports2) {
    "use strict";
    var node_buffer = require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports2.binary = binary;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports2.createPairs = createPairs;
    exports2.pairs = pairs;
    exports2.resolvePairs = resolvePairs;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports2.YAMLOMap = YAMLOMap;
    exports2.omap = omap;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports2.falseTag = falseTag;
    exports2.trueTag = trueTag;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports2.float = float;
    exports2.floatExp = floatExp;
    exports2.floatNaN = floatNaN;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports2.int = int;
    exports2.intBin = intBin;
    exports2.intHex = intHex;
    exports2.intOct = intOct;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports2.YAMLSet = YAMLSet;
    exports2.set = set;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports2) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports2.floatTime = floatTime;
    exports2.intTime = intTime;
    exports2.timestamp = timestamp;
  }
});

// ../../node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "../../node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports2.schema = schema;
  }
});

// ../../node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "../../node_modules/yaml/dist/schema/tags.js"(exports2) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports2.coreKnownTags = coreKnownTags;
    exports2.getTags = getTags;
  }
});

// ../../node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "../../node_modules/yaml/dist/schema/Schema.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports2.Schema = Schema;
  }
});

// ../../node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "../../node_modules/yaml/dist/stringify/stringifyDocument.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports2.stringifyDocument = stringifyDocument;
  }
});

// ../../node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "../../node_modules/yaml/dist/doc/Document.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path8, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path8, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path8) {
        if (Collection.isEmptyPath(path8)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path8) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path8, keepScalar) {
        if (Collection.isEmptyPath(path8))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path8, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path8) {
        if (Collection.isEmptyPath(path8))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path8) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path8, value) {
        if (Collection.isEmptyPath(path8)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path8), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path8, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports2.Document = Document;
  }
});

// ../../node_modules/yaml/dist/errors.js
var require_errors2 = __commonJS({
  "../../node_modules/yaml/dist/errors.js"(exports2) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports2.YAMLError = YAMLError;
    exports2.YAMLParseError = YAMLParseError;
    exports2.YAMLWarning = YAMLWarning;
    exports2.prettifyError = prettifyError;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-props.js"(exports2) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports2.resolveProps = resolveProps;
  }
});

// ../../node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "../../node_modules/yaml/dist/compose/util-contains-newline.js"(exports2) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports2.containsNewline = containsNewline;
  }
});

// ../../node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "../../node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports2) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports2.flowIndentCheck = flowIndentCheck;
  }
});

// ../../node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "../../node_modules/yaml/dist/compose/util-map-includes.js"(exports2) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports2.mapIncludes = mapIncludes;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-map.js"(exports2) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports2.resolveBlockMap = resolveBlockMap;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-seq.js"(exports2) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports2.resolveBlockSeq = resolveBlockSeq;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-end.js"(exports2) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports2.resolveEnd = resolveEnd;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports2.resolveFlowCollection = resolveFlowCollection;
  }
});

// ../../node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-collection.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports2.composeCollection = composeCollection;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports2.resolveBlockScalar = resolveBlockScalar;
  }
});

// ../../node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports2) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep2 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + match[1];
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports2.resolveFlowScalar = resolveFlowScalar;
  }
});

// ../../node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-scalar.js"(exports2) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports2.composeScalar = composeScalar;
  }
});

// ../../node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "../../node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports2) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports2.emptyScalarPosition = emptyScalarPosition;
  }
});

// ../../node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-node.js"(exports2) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports2.composeEmptyNode = composeEmptyNode;
    exports2.composeNode = composeNode;
  }
});

// ../../node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "../../node_modules/yaml/dist/compose/compose-doc.js"(exports2) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports2.composeDoc = composeDoc;
  }
});

// ../../node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "../../node_modules/yaml/dist/compose/composer.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors2();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports2.Composer = Composer;
  }
});

// ../../node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-scalar.js"(exports2) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors2();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports2.createScalarToken = createScalarToken;
    exports2.resolveAsScalar = resolveAsScalar;
    exports2.setScalarValue = setScalarValue;
  }
});

// ../../node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-stringify.js"(exports2) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "../../node_modules/yaml/dist/parse/cst-visit.js"(exports2) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path8) => {
      let item = cst;
      for (const [field, index] of path8) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path8) => {
      const parent = visit.itemAtPath(cst, path8.slice(0, -1));
      const field = path8[path8.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path8, item, visitor) {
      let ctrl = visitor(item, path8);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path8.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path8);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path8) : ctrl;
    }
    exports2.visit = visit;
  }
});

// ../../node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "../../node_modules/yaml/dist/parse/cst.js"(exports2) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports2.createScalarToken = cstScalar.createScalarToken;
    exports2.resolveAsScalar = cstScalar.resolveAsScalar;
    exports2.setScalarValue = cstScalar.setScalarValue;
    exports2.stringify = cstStringify.stringify;
    exports2.visit = cstVisit.visit;
    exports2.BOM = BOM;
    exports2.DOCUMENT = DOCUMENT;
    exports2.FLOW_END = FLOW_END;
    exports2.SCALAR = SCALAR;
    exports2.isCollection = isCollection;
    exports2.isScalar = isScalar;
    exports2.prettyToken = prettyToken;
    exports2.tokenType = tokenType;
  }
});

// ../../node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "../../node_modules/yaml/dist/parse/lexer.js"(exports2) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports2.Lexer = Lexer;
  }
});

// ../../node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "../../node_modules/yaml/dist/parse/line-counter.js"(exports2) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports2.LineCounter = LineCounter;
  }
});

// ../../node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "../../node_modules/yaml/dist/parse/parser.js"(exports2) {
    "use strict";
    var node_process = require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs11 = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs11, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs11);
              } else {
                Object.assign(it, { key: fs11, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs11 = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs11, sep: [] });
              else if (it.sep)
                this.stack.push(fs11);
              else
                Object.assign(it, { key: fs11, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports2.Parser = Parser;
  }
});

// ../../node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "../../node_modules/yaml/dist/public-api.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors2();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports2.parse = parse;
    exports2.parseAllDocuments = parseAllDocuments;
    exports2.parseDocument = parseDocument;
    exports2.stringify = stringify;
  }
});

// ../../node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "../../node_modules/yaml/dist/index.js"(exports2) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors2();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports2.Composer = composer.Composer;
    exports2.Document = Document.Document;
    exports2.Schema = Schema.Schema;
    exports2.YAMLError = errors.YAMLError;
    exports2.YAMLParseError = errors.YAMLParseError;
    exports2.YAMLWarning = errors.YAMLWarning;
    exports2.Alias = Alias.Alias;
    exports2.isAlias = identity.isAlias;
    exports2.isCollection = identity.isCollection;
    exports2.isDocument = identity.isDocument;
    exports2.isMap = identity.isMap;
    exports2.isNode = identity.isNode;
    exports2.isPair = identity.isPair;
    exports2.isScalar = identity.isScalar;
    exports2.isSeq = identity.isSeq;
    exports2.Pair = Pair.Pair;
    exports2.Scalar = Scalar.Scalar;
    exports2.YAMLMap = YAMLMap.YAMLMap;
    exports2.YAMLSeq = YAMLSeq.YAMLSeq;
    exports2.CST = cst;
    exports2.Lexer = lexer.Lexer;
    exports2.LineCounter = lineCounter.LineCounter;
    exports2.Parser = parser.Parser;
    exports2.parse = publicApi.parse;
    exports2.parseAllDocuments = publicApi.parseAllDocuments;
    exports2.parseDocument = publicApi.parseDocument;
    exports2.stringify = publicApi.stringify;
    exports2.visit = visit.visit;
    exports2.visitAsync = visit.visitAsync;
  }
});

// src/index.ts
var src_exports = {};
__export(src_exports, {
  CORE_PACKAGE_VERSION: () => CORE_PACKAGE_VERSION,
  DEFAULT_DATA_ROOT: () => DEFAULT_DATA_ROOT,
  FileRunStore: () => FileRunStore,
  MAX_RETAINED_DONE_RUNS: () => MAX_RETAINED_DONE_RUNS,
  WorkerHostImpl: () => WorkerHostImpl,
  WorkflowScriptRegistryImpl: () => WorkflowScriptRegistryImpl,
  abortRun: () => abortRun,
  configureCore: () => configureCore,
  configureNotifyDomain: () => configureNotifyDomain,
  createZcodeEngine: () => createZcodeEngine,
  discoverWorkflows: () => discoverWorkflows,
  evictDoneRunsBeyondCap: () => evictDoneRunsBeyondCap,
  executeNestedWorkflow: () => executeNestedWorkflow,
  getLogger: () => getLogger,
  getWorkflow: () => getWorkflow,
  getWorkflowByPath: () => getWorkflowByPath,
  invalidateCache: () => invalidateCache,
  killAllSpawnedChildren: () => killAllSpawnedChildren,
  lintScript: () => lintScript,
  loadWorkflows: () => loadWorkflows,
  registerZcodeEngine: () => registerZcodeEngine,
  routeEngine: () => routeEngine,
  runAndWait: () => runAndWait,
  runWorkflow: () => runWorkflow,
  scheduleTimeBudget: () => scheduleTimeBudget,
  terminateRunningRuns: () => terminateRunningRuns
});
module.exports = __toCommonJS(src_exports);

// src/core/host-services.ts
var import_node_os = require("os");
var import_node_path = require("path");
var DEFAULT_DATA_ROOT = (0, import_node_path.join)((0, import_node_os.homedir)(), ".subagent-core");
var configuredHost;
function configureCore(host) {
  configuredHost = host;
}
var NULL_HOST = {
  dataRoot() {
    throw new Error(
      "[subagent-core] core_host_not_configured: HostServices is not configured \u2014 the host shell must call configureCore(host) during initialization, before any core API that needs host services is consumed. Recovery: pi shell wires HostServices in src/host/pi-host.ts of @zhushanwen/pi-subagent-workflow; zsw shell: see the wiring example in the @zhushanwen/subagent-core package README."
    );
  },
  log(level, component, message, data) {
    const line = `[${component}] ${message}`;
    if (level === "error") {
      if (data === void 0) console.error(line);
      else console.error(line, data);
      return;
    }
    if (level === "warn") {
      if (data === void 0) console.warn(line);
      else console.warn(line, data);
      return;
    }
  }
  // discoveryRoots 刻意不实现：可选端口缺席 = undefined，由调用方走缺省发现语义。
};
function getHostServices() {
  return configuredHost ?? NULL_HOST;
}

// src/core/logger.ts
var facadeCache = /* @__PURE__ */ new Map();
function getLogger(component) {
  const existing = facadeCache.get(component);
  if (existing) return existing;
  const facade = {
    debug(msg, data) {
      getHostServices().log("debug", component, msg, data);
    },
    warn(msg, data) {
      getHostServices().log("warn", component, msg, data);
    },
    error(msg, data) {
      getHostServices().log("error", component, msg, data);
    }
  };
  facadeCache.set(component, facade);
  return facade;
}

// src/core/notify-ports.ts
var configuredPorts;
function configureNotifyDomain(ports) {
  configuredPorts = ports;
}

// src/execution/engine/common/errors.ts
var EngineError = class extends Error {
  code;
  /** 恢复指引：指向具体下一步（命令 / 配置路径 / 替代方案），非安慰性文案。 */
  recovery;
  constructor(code, detail, recovery) {
    super(`${code}: ${detail}`);
    this.name = "EngineError";
    this.code = code;
    this.recovery = recovery;
  }
  /** 结构化投影（InteractResult.code/message 与 GUI 警告条共用形态）。 */
  toStructured() {
    return { code: this.code, message: this.message, recovery: this.recovery };
  }
};
var DEFAULT_RECOVERY_HINTS = {
  engine_not_found: "Check the engine id in the agent .md frontmatter (engine: field) against the registered engine list, fix the typo, or install/register the engine first.",
  engine_probe_failed: "Confirm the engine version (e.g. `<engine> --version`), then re-run the engine probe. For contract drift, see docs/research/agent-engine-*.md for the expected output format.",
  engine_credential_missing: "Configure the engine credentials (see the engine credential section of docs/research/agent-engine-*.md), then retry \u2014 the preparer cannot synthesize credentials it has no source for.",
  nested_spawn_rejected: "Subagents must not spawn further subagents (unbounded recursion guard). Do the work directly inside the current task instead of delegating.",
  schema_emulation_failed: "The model output failed JSON extraction or schema validation. Retry once with a strengthened prompt (buildSchemaEmulationSegment output + the error tail); if it still fails, relax the schema or switch to a schema-native engine (engine: pi).",
  engine_timeout: "The engine was killed by the host timeout chain. Inspect the captured stdout tail, then re-run with a larger timeout, a narrower task, or `engine: pi`.",
  engine_capability_unsupported: "This engine declares the capability unsupported. Use a single-shot call instead of interactive steering, or dispatch with `engine: pi` which supports it.",
  engine_session_not_resumable: "Idle-process reuse does not survive a main-session reload. Use a cold resume path (engine --resume / --session with the recorded session reference), or start a new subagent.",
  model_not_available: "The requested model is not resolvable in this engine's provider system. Pick a model from the engine's available model list \u2014 the host never swaps engines implicitly on model mismatch.",
  prompt_too_large: "Shorten the task text, move the persona to the file channel, or use an engine with a stdin prompt channel.",
  engine_run_failed: "The engine process failed at runtime (parse failure / non-zero exit / contract drift). Check the captured stdout tail and exit code, confirm the engine version, re-run the probe, or retry with `engine: pi`."
};
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
function promptTooLargeError(actualBytes, limitBytes) {
  return new EngineError(
    "prompt_too_large",
    `estimated argv size ${actualBytes} bytes exceeds the ${limitBytes}-byte budget`,
    DEFAULT_RECOVERY_HINTS.prompt_too_large
  );
}
var STDOUT_TAIL_ECHO_CHARS = 2e3;
function engineTimeoutDetail(stdoutTail) {
  return `host timeout chain exhausted (SIGTERM -> grace -> SIGKILL). Stdout tail (last ${STDOUT_TAIL_ECHO_CHARS} chars): ${truncate(stdoutTail, STDOUT_TAIL_ECHO_CHARS)}. Recovery: ${DEFAULT_RECOVERY_HINTS.engine_timeout}`;
}

// src/execution/engine/registry.ts
var DEFAULT_ENGINE_ID = "pi";
var EngineNotFoundError = class extends Error {
  /** 结构化错误码（§3.3.3 错误规格表的 code 列，供调用方程序化分流）。 */
  code = "engine_not_found";
  /** 请求的（未注册的）引擎 id。 */
  engineId;
  /** 请求时刻的已注册清单快照（防错误对象跨时间读 Map 的失真）。 */
  registered;
  /** 错误来源定位（agent .md 文件路径 / 配置键等；运行期 getEngine 无来源不传）。 */
  source;
  constructor(engineId, registered, source) {
    super(
      `engine_not_found: engine '${engineId}' is not registered. Registered engines: ${registered.length > 0 ? registered.join(", ") : "(none)"}. Recovery: check the engine id in the agent .md frontmatter (engine: field) or the global default engine setting, fix the typo, or install/register the engine first (registered engines are listed above).` + (source !== void 0 ? ` Source: ${source}.` : "")
    );
    this.name = "EngineNotFoundError";
    this.engineId = engineId;
    this.registered = registered;
    this.source = source;
  }
};
var ENGINE_REGISTRY_SLOT_KEY = /* @__PURE__ */ Symbol.for("@zhushanwen/pi-subagent-workflow.engineRegistry");
function getRegistrySlot() {
  let slot = Reflect.get(globalThis, ENGINE_REGISTRY_SLOT_KEY);
  if (!slot) {
    slot = { factories: /* @__PURE__ */ new Map(), singletons: /* @__PURE__ */ new Map() };
    Reflect.set(globalThis, ENGINE_REGISTRY_SLOT_KEY, slot);
  }
  return slot;
}
function registerEngine(id, factory) {
  const slot = getRegistrySlot();
  slot.factories.set(id, factory);
  slot.singletons.delete(id);
}
function getEngine(id) {
  const slot = getRegistrySlot();
  const cached = slot.singletons.get(id);
  if (cached) return cached;
  const factory = slot.factories.get(id);
  if (!factory) {
    throw new EngineNotFoundError(id, listEngines());
  }
  const engine = factory();
  slot.singletons.set(id, engine);
  return engine;
}
function hasEngine(id) {
  return getRegistrySlot().factories.has(id);
}
function listEngines() {
  return [...getRegistrySlot().factories.keys()];
}

// src/execution/engine/routing.ts
function hasText(v) {
  return v !== void 0 && v !== "";
}
function resolveEngineRouting(input) {
  if (hasText(input.callEngine)) {
    return { engineId: input.callEngine, source: "call" };
  }
  if (hasText(input.agentEngine)) {
    return { engineId: input.agentEngine, source: "frontmatter" };
  }
  if (hasText(input.globalDefaultEngine)) {
    return { engineId: input.globalDefaultEngine, source: "default" };
  }
  return { engineId: DEFAULT_ENGINE_ID, source: "default" };
}
async function routeEngine(opts) {
  const has = opts.hasEngineFn ?? hasEngine;
  const get = opts.getEngineFn ?? getEngine;
  const routing = resolveEngineRouting(opts.routing);
  if (!has(routing.engineId)) {
    throw new EngineNotFoundError(routing.engineId, opts.listEnginesFn?.() ?? listEngines(), describeRoutingSource(opts.routing));
  }
  if (routing.engineId === DEFAULT_ENGINE_ID) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source
    };
  }
  const report = await opts.probe(routing.engineId);
  if (report.ok) {
    return {
      engine: get(routing.engineId),
      engineId: routing.engineId,
      requestedEngineId: routing.engineId,
      source: routing.source
    };
  }
  if (opts.strict) {
    throw probeFailedError(routing.engineId, report, "engineRouting.strict=true\uFF1Aprobe \u5931\u8D25\u4E00\u5F8B\u62A5\u9519\uFF08\u4E0D fallback\uFF09");
  }
  if (routing.source === "call") {
    throw probeFailedError(routing.engineId, report, "engine \u6765\u81EA\u8C03\u7528\u53C2\u6570\u663E\u5F0F\u6307\u5B9A\uFF08\u80FD\u529B\u4F9D\u8D56\u58F0\u660E\uFF09\u2014\u2014\u4E0D\u515C\u5E95");
  }
  const fallbackId = fallbackTargetId(opts.routing, routing);
  if (hasText(opts.taskModel) && fallbackId !== routing.engineId) {
    throw new EngineError(
      "model_not_available",
      `engine '${routing.engineId}' probe \u5931\u8D25\u4E14\u4EFB\u52A1\u663E\u5F0F\u6307\u5B9A model '${opts.taskModel}'\u2014\u2014model \u4E0E\u5F15\u64CE provider \u4F53\u7CFB\u7ED1\u5B9A\uFF0C\u6362\u5F15\u64CE\uFF08fallback \u5230 '${fallbackId}'\uFF09\u4E0D\u9759\u9ED8\u6267\u884C`,
      `\u4FEE\u590D engine '${routing.engineId}' \u7684\u63A2\u9488\u5931\u8D25\uFF08\u89C1\u4E0A\u65B9\u6062\u590D\u6307\u5F15\uFF09\u540E\u91CD\u8BD5\uFF0C\u6216\u53BB\u6389 model \u6307\u5B9A / \u663E\u5F0F\u4F20 engine: '${fallbackId}' \u786E\u8BA4\u6A21\u578B\u53EF\u7528\u540E\u518D\u6D3E\u53D1`
    );
  }
  return {
    engine: get(fallbackId),
    engineId: fallbackId,
    requestedEngineId: routing.engineId,
    source: "default",
    engineFallback: { from: routing.engineId, reason: "engine_probe_failed" }
  };
}
function fallbackTargetId(routingInput, resolved) {
  if (resolved.source === "default") return DEFAULT_ENGINE_ID;
  const global = routingInput.globalDefaultEngine;
  if (hasText(global) && global !== DEFAULT_ENGINE_ID && global !== resolved.engineId) {
    return global;
  }
  return DEFAULT_ENGINE_ID;
}
function probeFailedError(engineId, report, guard) {
  const checks = report.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(", ");
  return new EngineError(
    "engine_probe_failed",
    `engine '${engineId}' probe \u5931\u8D25\uFF08${guard}\uFF09\u3002checks: [${checks}]`,
    report.error?.recovery ?? `Confirm the engine binary and version, then re-run the probe (probe({force:true}) or re-initialize the engine).`
  );
}
function describeRoutingSource(routing) {
  if (hasText(routing.callEngine)) {
    return `call parameter engine='${routing.callEngine}'`;
  }
  if (hasText(routing.agentEngine)) {
    return `agent frontmatter engine='${routing.agentEngine}'`;
  }
  return void 0;
}

// src/shared/timer-delay.ts
var MAX_TIMER_DELAY_MS = 2147483647;
function assertSafeTimerDelay(ms, source) {
  if (!Number.isFinite(ms)) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} is not a finite number (NaN/\xB1Infinity). Non-finite delays collapse to 1ms in Node setTimeout and fire immediately. Recovery: fix the upstream computation that produced this value (e.g. guard division/parse results before passing them in) and retry.`
    );
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} exceeds the Node setTimeout limit (${MAX_TIMER_DELAY_MS} ms = 2^31-1); larger delays silently collapse to 1ms and fire immediately. Recovery: clamp the value to <= ${MAX_TIMER_DELAY_MS} (e.g. omit the option for "unlimited" semantics, or clamp explicitly) and retry.`
    );
  }
}

// src/orchestration/args-validator.ts
var import_ajv = __toESM(require_ajv(), 1);
var ArgsValidationError = class extends Error {
  workflowName;
  /** ajv 校验错误数组（畸形 schema 时为 undefined）。 */
  errors;
  constructor(workflowName, message, errors) {
    super(message);
    this.name = "ArgsValidationError";
    this.workflowName = workflowName;
    this.errors = errors;
  }
};
var ajv = new import_ajv.default({
  coerceTypes: true,
  strictSchema: false,
  allErrors: true,
  useDefaults: false
});
function formatMessage(name, errors) {
  const lines = errors.map((e) => {
    let path8 = "/";
    let msg = "invalid";
    if (e !== null && typeof e === "object") {
      const err = e;
      if (typeof err.instancePath === "string" && err.instancePath) path8 = err.instancePath;
      if (typeof err.message === "string") msg = err.message;
    }
    return `- ${path8}: ${msg}`;
  });
  return `Invalid args for workflow '${name}': ${errors.length} error(s)
${lines.join("\n")}
Read the workflow script file (location from <available_workflows>) for the parameter schema and usage.`;
}
function validateRunArgs(spec) {
  const { parameters, args, scriptName } = spec;
  if (parameters === void 0) return;
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema (expected object). Read the workflow script file (location from <available_workflows>) to inspect it.`
    );
  }
  const schema = parameters;
  const properties = schema.properties !== null && typeof schema.properties === "object" ? schema.properties : {};
  for (const key of Object.keys(args)) {
    if (args[key] !== null) continue;
    const prop = properties[key];
    let isNullable = false;
    if (prop !== null && typeof prop === "object") {
      const propType = prop.type;
      isNullable = Array.isArray(propType) ? propType.includes("null") : propType === "null";
    }
    if (!isNullable) delete args[key];
  }
  let validate;
  try {
    validate = ajv.compile(parameters);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema: ${detail}. Read the workflow script file (location from <available_workflows>) to inspect it.`
    );
  }
  if (!validate(args)) {
    throw new ArgsValidationError(
      scriptName,
      formatMessage(scriptName, validate.errors ?? []),
      validate.errors ?? void 0
    );
  }
}

// src/execution/engine/common/kill-chain.ts
var logger = getLogger("subagents");
var SIGKILL_REAP_TIMEOUT_MS = 1e4;
var HOST_TIMEOUT_ABORT_REASON = "agent-call-timeout";
async function killChain(child, opts) {
  if (child.exitCode !== null || child.signalCode !== null) return "terminated";
  const exited = waitForExit(child);
  safeKill(child, "SIGTERM");
  const graceful = await raceTimeout(exited, opts.graceMs);
  if (graceful === "settled") return "terminated";
  if (child.exitCode !== null || child.signalCode !== null) return "terminated";
  safeKill(child, "SIGKILL");
  await raceTimeout(exited, SIGKILL_REAP_TIMEOUT_MS);
  return "killed";
}
function safeKill(child, signal) {
  try {
    child.kill(signal);
  } catch (err) {
    logger.debug(
      `[kill-chain] ${signal} on exited process: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function synthesizeTimeoutOutcome(task, stdoutTail, engineId = DEFAULT_ENGINE_ID) {
  return {
    content: "",
    // slug 进错误信息：单看 outcome（record 之外）也能定位是哪个任务超时
    error: `engine_timeout: [slug=${task.slug}] ${engineTimeoutDetail(stdoutTail)}`,
    // 被信号杀死：退出码语义为 null（§3.3.5 AgentOutcome.exitCode 注释）
    exitCode: null,
    engineId
  };
}
function waitForExit(child) {
  return new Promise((resolve4) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve4();
      return;
    }
    child.once("exit", () => resolve4());
  });
}
function raceTimeout(p, ms) {
  return new Promise((resolve4) => {
    const timer = setTimeout(() => resolve4("timeout"), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve4("settled");
      },
      () => {
        clearTimeout(timer);
        resolve4("settled");
      }
    );
  });
}

// src/execution/execute-options-mapper.ts
var SLUG_MAX_LENGTH = 35;

// src/execution/execution-record.ts
function addUsage(prev, next) {
  if (prev === void 0) {
    return {
      input: next.input ?? 0,
      output: next.output ?? 0,
      cacheRead: next.cacheRead ?? 0,
      cacheWrite: next.cacheWrite ?? 0,
      cost: next.cost
    };
  }
  return {
    input: (prev.input ?? 0) + (next.input ?? 0),
    output: (prev.output ?? 0) + (next.output ?? 0),
    cacheRead: (prev.cacheRead ?? 0) + (next.cacheRead ?? 0),
    cacheWrite: (prev.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    cost: (prev.cost ?? 0) + (next.cost ?? 0)
  };
}
function emptyTurn() {
  return { text: "", thinking: "", toolCalls: [], usageDelta: void 0, closed: false };
}
function createRecord(id, identity) {
  return {
    id,
    agent: identity.agent,
    model: identity.model,
    thinkingLevel: identity.thinkingLevel,
    mode: identity.mode,
    task: identity.task,
    slug: identity.slug,
    startedAt: identity.startedAt,
    rootSessionId: identity.rootSessionId,
    parentRecordId: identity.parentRecordId,
    depth: identity.depth ?? 0,
    chatMode: identity.chatMode,
    idleTimeoutMs: identity.idleTimeoutMs,
    engine: identity.engine,
    engineFallback: identity.engineFallback,
    // 状态（实时更新）
    status: "running",
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: void 0,
    // 对话轮次计数（首轮 = 0，每完成一轮 finalizeRoundToIdle +1）。非 chatMode 不自增。
    round: 0,
    // 完成（completeRecord 唯一写点）
    endedAt: void 0,
    result: void 0,
    error: void 0,
    agentResult: void 0,
    // 控制（仅 background 持有 controller；sync 为 undefined）
    controller: identity.controller
  };
}
function currentTurn(record) {
  const last = record.turns[record.turns.length - 1];
  if (last !== void 0 && !last.closed) return last;
  const fresh = emptyTurn();
  record.turns.push(fresh);
  return fresh;
}
function findRunningToolCall(record, toolName) {
  for (let t = record.turns.length - 1; t >= 0; t--) {
    const turn = record.turns[t];
    if (turn === void 0) continue;
    for (let i = turn.toolCalls.length - 1; i >= 0; i--) {
      const tc = turn.toolCalls[i];
      if (tc?._status === "running" && tc.toolName === toolName) {
        return [turn, i];
      }
    }
  }
  return void 0;
}
var runningToolIndex = /* @__PURE__ */ new WeakMap();
function indexToolStart(record, turn, toolName) {
  let byName = runningToolIndex.get(record);
  if (byName === void 0) {
    byName = /* @__PURE__ */ new Map();
    runningToolIndex.set(record, byName);
  }
  const arr = byName.get(toolName);
  if (arr === void 0) {
    byName.set(toolName, [{ turn, idx: turn.toolCalls.length - 1 }]);
  } else {
    arr.push({ turn, idx: turn.toolCalls.length - 1 });
  }
}
function updateFromEvent(record, event) {
  switch (event.type) {
    // ── text / thinking：流式累积进当前 turn ──
    case "text_delta": {
      currentTurn(record).text += event.delta;
      return;
    }
    case "thinking_delta": {
      currentTurn(record).thinking += event.delta;
      return;
    }
    // ── tool_start：push 一个 running 的 InternalToolCall（带 startedTs）──
    case "tool_start": {
      const tc = {
        toolName: event.toolName,
        args: event.args,
        result: void 0,
        isError: false,
        _status: "running",
        startedTs: Date.now()
      };
      const turn = currentTurn(record);
      turn.toolCalls.push(tc);
      indexToolStart(record, turn, event.toolName);
      return;
    }
    // ── tool_end：索引弹尾 O(1) 定位 running 同名 toolCall，miss 回退全扫兜底 ──
    case "tool_end": {
      let matched;
      const byName = runningToolIndex.get(record);
      const arr = byName?.get(event.toolName);
      if (arr !== void 0 && arr.length > 0) {
        const item = arr[arr.length - 1];
        arr.pop();
        const tc = item.turn.toolCalls[item.idx];
        if (tc !== void 0 && tc._status === "running") {
          matched = [item.turn, item.idx];
        }
      }
      if (matched === void 0) {
        matched = findRunningToolCall(record, event.toolName);
      }
      if (matched !== void 0) {
        const [turn, i] = matched;
        const tc = turn.toolCalls[i];
        tc.args = event.args ?? tc.args;
        tc.result = event.result;
        tc.isError = event.isError ?? false;
        tc._status = event.isError ? "failed" : "done";
        return;
      }
      currentTurn(record).toolCalls.push({
        toolName: event.toolName,
        args: event.args,
        result: event.result,
        isError: event.isError ?? false,
        _status: event.isError ? "failed" : "done",
        startedTs: Date.now()
      });
      return;
    }
    // ── turn_end：闭合当前 turn，记 closedTs，turnCount++，清 lastError ──
    case "turn_end": {
      const turn = currentTurn(record);
      turn.closed = true;
      turn.closedTs = Date.now();
      record.turnCount += 1;
      record.lastError = void 0;
      return;
    }
    // ── message_end：usage 增量累加进 currentTurn().usageDelta，totalTokens 累加 ──
    //
    // usageDelta 按 message_end **累加**（非覆盖）——同一 turn 内若多次 message_end
    // 到达（或 turn_end 后的滞后 message_end 落到 currentTurn 开的新 turn），
    // 累加保证不丢 usage。getTotalUsage 扁平求和所有 turn，归属 turn 的精确性
    // 不影响最终 total（无消费方读单 turn usage）。
    case "message_end": {
      if (event.usage) {
        const turn = currentTurn(record);
        turn.usageDelta = addUsage(turn.usageDelta, event.usage);
        record.totalTokens += (event.usage.input ?? 0) + (event.usage.output ?? 0) + (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0);
      }
      if (event.error) {
        record.lastError = event.error;
      }
      return;
    }
    // ── error：存 record.lastError（getEventLog 派生 error 条目）──
    case "error": {
      record.lastError = event.message;
      return;
    }
    // ── compaction：不产生数据（不变）──
    case "compaction": {
      return;
    }
    default: {
      const _exhaustive = event;
      return _exhaustive;
    }
  }
}

// src/execution/stream-sink.ts
var STREAM_FLUSH_MS = 100;
var MAX_WIDGET_LINES = 200;
var SubagentStream = class {
  widgetKey;
  sink;
  buffer = "";
  timer;
  hasFlushed = false;
  disposed = false;
  constructor(recordId, sink) {
    this.widgetKey = `subagent-stream-${recordId}`;
    this.sink = sink;
  }
  /** 接收一个 text_delta 增量。空串静默丢弃（不消耗 leading edge）。 */
  onDelta(delta) {
    if (this.disposed || delta.length === 0) return;
    this.buffer += delta;
    if (!this.hasFlushed) {
      this.hasFlushed = true;
      this.flush();
    } else if (this.timer === void 0) {
      this.timer = setTimeout(() => this.flush(), STREAM_FLUSH_MS);
    }
  }
  /** 终态清理：清除 widget + 清 timer（幂等）。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    this.sink.setWidget(this.widgetKey, void 0);
  }
  flush() {
    this.timer = void 0;
    if (this.buffer.length === 0 || this.disposed) return;
    const lines = this.buffer.split("\n");
    if (lines.length <= MAX_WIDGET_LINES) {
      this.sink.setWidget(this.widgetKey, lines);
      return;
    }
    const dropped = lines.length - MAX_WIDGET_LINES;
    this.sink.setWidget(this.widgetKey, [
      `(... ${dropped} earlier lines truncated, full output in /subagents detail)`,
      ...lines.slice(dropped)
    ]);
  }
};

// src/orchestration/skill-discovery.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var skillCandidatesCache = /* @__PURE__ */ new Map();
function getNpmSkillCandidates(npmSkillsDir) {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;
  const candidates = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch {
  }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}
var skillMemo = /* @__PURE__ */ new Map();
function resolveWithinRoot(rootDir, skillName) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, skillName);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return void 0;
  }
  return resolved;
}
function resolveSkillPath(skillName) {
  if (skillMemo.has(skillName)) {
    return skillMemo.get(skillName);
  }
  const candidates = [];
  const pushCandidate = (dir) => {
    if (dir !== void 0) candidates.push(dir);
  };
  pushCandidate(resolveWithinRoot(path.resolve(process.cwd(), ".agents/skills"), skillName));
  const injectedSkillRoots = getHostServices().discoveryRoots?.()?.skills ?? [];
  const userSkillsRoot = injectedSkillRoots.find((root) => root.source === "user-pi");
  if (userSkillsRoot !== void 0) {
    pushCandidate(resolveWithinRoot(userSkillsRoot.dir, skillName));
  }
  const npmSkillsRoot = injectedSkillRoots.find((root) => root.source === "npm");
  if (npmSkillsRoot !== void 0) {
    for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsRoot.dir)) {
      pushCandidate(resolveWithinRoot(pkgSkillsBase, skillName));
    }
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      skillMemo.set(skillName, dir);
      return dir;
    }
  }
  skillMemo.set(skillName, void 0);
  return void 0;
}

// src/shared/schema-jsonify.ts
var cache = /* @__PURE__ */ new WeakMap();
var PRETTY_PRINT_INDENT_SPACES = 2;
function stringifySchemaCached(schema, mode) {
  let entry = cache.get(schema);
  if (!entry) {
    entry = {};
    cache.set(schema, entry);
  }
  const hit = entry[mode];
  if (hit !== void 0) return hit;
  const serialized = mode === "compact" ? JSON.stringify(schema) : JSON.stringify(schema, null, PRETTY_PRINT_INDENT_SPACES);
  if (serialized === void 0) {
    throw new Error(
      `[subagent-workflow] stringifySchemaCached: JSON.stringify returned undefined (mode=${mode}) \u2014 the schema object defines a toJSON hook returning undefined. Recovery: check the schema source (agent definition / workflow script), remove that toJSON or make it return a JSON-serializable value.`
    );
  }
  entry[mode] = serialized;
  return serialized;
}

// src/orchestration/agent-opts-resolver.ts
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectRootSchema(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema.type === "object") return true;
  if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
  const OBJECT_ONLY_KEYS = [
    "properties",
    "required",
    "patternProperties",
    "additionalProperties",
    "minProperties",
    "maxProperties",
    "dependencies",
    "dependentRequired",
    "propertyNames"
  ];
  return OBJECT_ONLY_KEYS.some((k) => k in schema);
}
function formatSchemaInstruction(schema) {
  const schemaJson = stringifySchemaCached(schema, "compact");
  const isObjectRoot = isObjectRootSchema(schema);
  const argsContractLine = isObjectRoot ? "Your call arguments ARE the result data itself \u2014 the tool's parameter schema IS the required shape of your result." : "The tool's single argument must be an object `{value: <data>}` \u2014 put the result itself in `value`, and it must conform to the schema below. Validation errors may reference paths starting with `value.` (e.g. `value.0`, `value.name`): that prefix addresses the wrapper, not your data.";
  const rulesCallLine = isObjectRoot ? "- Call the structured-output tool with your result data as its arguments. The system validates them against the schema above automatically." : "- Call the structured-output tool with `{value: <your result data>}`. The system validates the `value` field against the schema above automatically.";
  const apLine = schema.additionalProperties === void 0 ? "- Fields not defined in this schema are rejected \u2014 do not add extra fields." : "- Extra fields follow this schema's own additionalProperties declaration.";
  return [
    "## MANDATORY: Structured Output Requirement",
    "",
    "This task requires structured output.",
    "Your FINAL action must be calling the `structured-output` tool.",
    "",
    argsContractLine,
    `Your result must conform to this schema:`,
    "```json",
    schemaJson,
    "```",
    "",
    "Rules:",
    rulesCallLine,
    "- Do NOT output JSON in your text response \u2014 use the structured-output tool.",
    "- Do NOT skip this step. The structured-output call IS your result.",
    "- Complete all other work FIRST, then call structured-output as the last action.",
    apLine
  ].join("\n");
}
function resolveAgentOpts(opts) {
  const appendSystemPrompt = [];
  if (opts.skill) {
    const skillPath = resolveSkillPath(opts.skill);
    if (!skillPath) {
      return { opts, error: `Skill not found: ${opts.skill}. Searched .agents/skills/ and ~/.pi/agent/skills/` };
    }
    opts = { ...opts, skillPath };
  }
  if (opts.schema) {
    appendSystemPrompt.push(formatSchemaInstruction(opts.schema));
    opts = { ...opts, schemaEnv: stringifySchemaCached(opts.schema, "compact") };
  }
  return {
    opts: { ...opts, ...appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {} }
  };
}

// src/orchestration/execute-agent-call.ts
var BACKOFF_BASE_MS = 1e3;
var BACKOFF_EXPONENT_BASE = 2;
var MAX_ATTEMPTS = 3;
var STALE_CONTEXT_PATTERNS = [
  "ctx is stale",
  "stale after session replacement",
  "context canceled",
  "aborted"
];
function isStaleContextErrorMsg(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}
var DETERMINISTIC_SCHEMA_FAILURE_PREFIX = "Structured output failed deterministically:";
function isDeterministicSchemaFailureMsg(msg) {
  if (!msg) return false;
  return msg.includes(DETERMINISTIC_SCHEMA_FAILURE_PREFIX);
}
function backoffDelay(retryIndex) {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_EXPONENT_BASE, retryIndex - 1);
}
function finalizeCall(call, result, trace, isOrphaned) {
  call.markDone(result);
  const status = result.error === void 0 ? "completed" : "failed";
  if (result.sessionId !== void 0) call.setSessionId(result.sessionId);
  if (result.sessionFile !== void 0) call.setSessionFile(result.sessionFile);
  if (isOrphaned?.()) return;
  trace.update(call.id, {
    status,
    result,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: result.sessionId,
    sessionFile: result.sessionFile
  });
}
function delay(ms) {
  return new Promise((resolve4) => {
    const timer = setTimeout(resolve4, ms);
    timer.unref();
  });
}
async function executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned) {
  call.markRunning();
  const result = await runner.run(call.opts, signal, onEvent, stream);
  if (result.usage) {
    budget.consume(result.usage);
  }
  if (result.error !== void 0 && isStaleContextErrorMsg(result.error)) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && isDeterministicSchemaFailureMsg(result.error)) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (signal.aborted) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && budget.isExceeded()) {
    finalizeCall(call, result, trace, isOrphaned);
    budget.incrementCallCount();
    return;
  }
  if (result.error !== void 0 && call.attempts < MAX_ATTEMPTS) {
    await delay(backoffDelay(call.attempts));
    if (signal.aborted) {
      finalizeCall(call, result, trace, isOrphaned);
      budget.incrementCallCount();
      return;
    }
    await executeAgentCall(call, runner, budget, signal, trace, onEvent, stream, isOrphaned);
    return;
  }
  finalizeCall(call, result, trace, isOrphaned);
  budget.incrementCallCount();
}

// src/orchestration/models/agent-call.ts
var AgentCall = class {
  id;
  opts;
  status = "pending";
  attempts = 0;
  result;
  /** Pi subprocess session ID（uuidv7，G-017 归此）。 */
  sessionId;
  /** Session JSONL 绝对路径（finalizeCall 后从 result.sessionFile 填入，对齐 sessionId 模式）。 */
  sessionFile;
  /** 与 Trace 共享的节点引用（D-10 单源）。AgentCall 不直接改其字段。 */
  traceNode;
  constructor(id, opts, traceNode) {
    this.id = id;
    this.opts = opts;
    this.traceNode = traceNode;
  }
  /**
  * 标记进入 running 状态（dispatch 前）。attempts++（含首次）。
  * @throws 若已 done（不可重启）
  */
  markRunning() {
    if (this.status === "done") {
      throw new Error(`AgentCall ${this.id} already done \u2014 cannot mark running`);
    }
    this.status = "running";
    this.attempts += 1;
  }
  /**
  * 标记完成（成功或失败均调用——result.error 区分）。
  * @throws 若当前非 running（pending 不能直接跳 done，必须先 markRunning）
  */
  markDone(result) {
    if (this.status !== "running") {
      throw new Error(`AgentCall ${this.id} must be running to mark done (was ${this.status})`);
    }
    this.result = result;
    this.status = "done";
  }
  /** 记录 pi subprocess session ID（dispatch 成功后）。 */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }
  /** 记录 session JSONL 绝对路径（finalizeCall 后，对齐 setSessionId 模式）。 */
  setSessionFile(sessionFile) {
    this.sessionFile = sessionFile;
  }
};

// src/orchestration/models/run-runtime.ts
var RunRuntime = class {
  /** Worker 线程句柄。 */
  worker;
  /** per-running-segment AbortController（一次性，无法复用——G3-001）。 */
  controller;
  /** Run 级墙钟时间预算计时器（spec.budgetTimeMs > 0 时由 lifecycle 调度，
    * 到期 abortRun time_limited）。release 时清理，避免 abort/replaceRuntime
    * 后孤儿计时器仍触发（rebuildRuntime 会重排一个全新的计时器，旧的不应残留）。 */
  timeBudgetTimer;
  /**
  * 本 runtime 代际是否已收到 worker 的终态消息（return / error）。
  *
  * [F1] worker exit(0) 且本标记为 false = worker 静默退出、未交付任何终态——最常见根因
  * 是 execute() 返回值不可克隆，worker 侧 _safePost 吞掉 DataCloneError 后 return 消息
  * 根本没发出。旧实现 handleWorkerExit 对 code===0 no-op → run 永久 running、runAndWait
  * 悬挂。handleWorkerExit 据此判定转 done,failed。
  *
  * 按代际归零：字段挂在 RunRuntime（每代际 new 一个实例）而非 run.meta——script-error
  * 重试退避窗口内（error 消息已收到、run 仍 running、旧 worker exit(0)）必须 no-op 等
  * rebuild；若挂 meta 则 rebuild 后新 worker 再静默退出时会被旧标记误放行，重新悬挂。
  *
  * 写点：① handleWorkerMessage 的 return/error 分支（WorkerHandle.isCurrent 守卫保证
  * 消息必来自当前代际）；② handleWorkerError 进入处理前（[R4-F1] 同代际幂等守卫——
  * worker 崩溃时 error + exit(1) 双事件各派发一次 handleWorkerError，第一个事件标记
  * 本代际已处理，第二个事件命中标志跳过，消除单次崩溃计数 +2 / 双 rebuild 交错）。
  * rebuildRuntime 构造新 RunRuntime 自然重置。
  */
  receivedTerminalMessage = false;
  /** 防止 release 重复执行（幂等）。 */
  released = false;
  constructor(worker, controller, timeBudgetTimer) {
    this.worker = worker;
    this.controller = controller;
    this.timeBudgetTimer = timeBudgetTimer;
  }
  /**
  * 释放所有资源：terminate worker + abort controller。
  *
  * 幂等——重复调用安全（第二次起 no-op，released flag 守卫）。
  * 调用后此 RunRuntime 应被调用方丢弃（WorkflowRun.runtime = undefined），
  * 崩溃重试时由 replaceRuntime 注入新实例（G3-001）。
  *
  * worker.terminate 本身幂等，controller.abort 本身幂等
  * （重复 abort 无副作用），但 released flag 让本方法语义更明确：
  * 「释放过一次的 runtime 不再释放第二次」。
  *
  * @param mode terminal —— 终局释放（唯一值，保留参数为调用方语义显式化）
  */
  release(_mode) {
    if (this.released) return;
    this.released = true;
    if (this.timeBudgetTimer) clearTimeout(this.timeBudgetTimer);
    void this.worker.terminate();
    this.controller.abort();
  }
  /** 是否已 release（测试 + 诊断用）。 */
  get isReleased() {
    return this.released;
  }
};

// src/orchestration/error-recovery.ts
var logger2 = getLogger("subagents");
var MAX_WORKER_RETRIES = 3;
var RETRY_BACKOFF_BASE_MS = 1e3;
var EXPONENTIAL_BACKOFF_BASE = 2;
var MAX_ERROR_LOGS = 500;
var MALFORMED_MSG_LOG_PREVIEW_CHARS = 200;
var WORKER_EXITED_WITHOUT_RESULT_MSG = "worker exited before delivering a result (return value may not be structured-cloneable)";
function isTerminal(run) {
  return run.state.status === "done";
}
function isOrphanedCall(run, callId, call) {
  return run.state.calls.get(callId) !== call;
}
function backoffDelay2(retryIndex) {
  return RETRY_BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, retryIndex - 1);
}
async function saveRunBestEffort(run, deps, context) {
  try {
    await deps.store.save(run);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger2.error(
      `[workflow] store.save failed (${context}, runId=${run.runId}): ${m}. Continuing state-machine finalization (in-memory state already terminal).`
    );
  }
}
function delay2(ms) {
  return new Promise((resolve4) => {
    const timer = setTimeout(resolve4, ms);
    timer.unref();
  });
}
function discardInFlightCalls(run) {
  const inFlight = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  for (const callId of inFlight) {
    run.state.calls.delete(callId);
    run.state.trace.removeByStepIndex(callId);
  }
  return inFlight.sort((a, b) => a - b);
}
function remainingTimeBudgetMs(run) {
  const budget = run.spec.budgetTimeMs;
  if (!budget || budget <= 0) return void 0;
  const startedMs = Date.parse(run.meta.startedAt);
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  return Math.max(0, budget - elapsed);
}
async function finalizeTimeBudgetExhausted(run, deps) {
  deps.log?.("debug", "workflow:error-recovery", "time budget exhausted on rebuild, transition done", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs
  });
  run.state.error = run.state.error ?? `Time budget exhausted (${run.spec.budgetTimeMs} ms wall clock) before retry rebuild`;
  let transitioned = false;
  try {
    run.transition("done", "time_limited");
    transitioned = true;
  } catch (te) {
    void te;
  }
  if (!transitioned) return;
  await deps.store.save(run).catch((e) => {
    const m = e instanceof Error ? e.message : String(e);
    logger2.error(`[workflow] store.save failed (time budget exhausted): ${m}`);
  });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "time_limited" });
  deps.onRunDone?.(run);
}
function rebuildRuntime(run, deps, handlers) {
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild start", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs
  });
  const controller = new AbortController();
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
  let timeBudgetTimer;
  const remainingBudgetMs = remainingTimeBudgetMs(run);
  if (remainingBudgetMs !== void 0 && remainingBudgetMs > 0 && deps.scheduleTimeBudget) {
    timeBudgetTimer = deps.scheduleTimeBudget(run.runId, remainingBudgetMs);
    deps.log?.("debug", "workflow:error-recovery", "time budget rescheduled", {
      runId: run.runId,
      budgetTimeMs: remainingBudgetMs
    });
  }
  run.replaceRuntime(new RunRuntime(worker, controller, timeBudgetTimer));
  const discardedCallIds = discardInFlightCalls(run);
  deps.log?.("debug", "workflow:error-recovery", "in-flight calls discarded", {
    runId: run.runId,
    callIds: discardedCallIds,
    count: discardedCallIds.length
  });
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild complete", {
    runId: run.runId
  });
}
async function handleWorkerMessage(run, raw, deps, handlers) {
  if (isTerminal(run)) return;
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "workflow-call":
      dispatchWorkflowCall(run, msg, deps);
      return;
    case "return":
      if (run.runtime) run.runtime.receivedTerminalMessage = true;
      await handleReturn(run, msg, deps);
      return;
    case "error":
      if (run.runtime) run.runtime.receivedTerminalMessage = true;
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers
      );
      return;
  }
}
function dispatchAgentCall(run, msg, deps) {
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) || typeof msg.opts !== "object" || msg.opts === null || typeof msg.opts.prompt !== "string") {
    logger2.error(`[workflow] malformed agent-call message: callId=${JSON.stringify(msg.callId)}, opts=${JSON.stringify(msg.opts)?.slice(0, MALFORMED_MSG_LOG_PREVIEW_CHARS)}`);
    return;
  }
  const cached = run.state.calls.get(msg.callId);
  if (cached && cached.status === "done") {
    postAgentResult(run, msg.callId, cached.result, true);
    return;
  }
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  const liveSlug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const liveRecord = createRecord(String(msg.callId), {
    agent: agentName,
    model: msg.opts.model ?? "default",
    mode: "background",
    task: msg.opts.prompt,
    slug: liveSlug,
    startedAt: Date.now()
  });
  const node = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model: msg.opts.model ?? "default",
    status: "running",
    phase: msg.phase,
    startedAt: now,
    live: liveRecord
  };
  run.state.trace.append(node);
  const rawSchema = msg.opts.schema;
  const opts = {
    ...msg.opts,
    schema: typeof rawSchema === "object" && rawSchema !== null ? rawSchema : void 0
  };
  const resolved = resolveAgentOpts(opts);
  if (resolved.error) {
    const call2 = new AgentCall(msg.callId, opts, node);
    call2.markRunning();
    const errorResult = { content: "", error: resolved.error };
    call2.markDone(errorResult);
    run.state.calls.set(msg.callId, call2);
    node.live = void 0;
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    postAgentResult(run, msg.callId, errorResult, false);
    deps.store.save(run).catch((e) => {
      logger2.error(`[workflow] store.save failed (resolveAgentOpts): ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }
  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);
  const runtime = run.runtime;
  const signal = runtime.controller.signal;
  const onEvent = (event) => {
    updateFromEvent(liveRecord, event);
  };
  const stream = deps.streamSink ? new SubagentStream(`${run.runId}-${msg.callId}`, deps.streamSink) : void 0;
  const dispatchCall = async () => {
    if (signal.aborted) {
      const abortErr = new Error("Operation aborted before start");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    try {
      await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream, () => isOrphanedCall(run, msg.callId, call));
    } finally {
      stream?.dispose();
    }
  };
  void dispatchCall().then(() => {
    node.live = void 0;
    if (run.state.status !== "running") return;
    if (isOrphanedCall(run, msg.callId, call)) {
      deps.log?.("debug", "workflow:error-recovery", "orphan agent call completion dropped", { runId: run.runId, callId: msg.callId });
      return;
    }
    if (call.result) postAgentResult(run, msg.callId, call.result, false);
    postBudgetUpdate(run);
    deps.store.save(run).catch((e) => {
      const m = e instanceof Error ? e.message : String(e);
      logger2.error(`[workflow] store.save failed (agent call ${msg.callId}): ${m}`);
    });
    if (run.state.budget.isExceeded()) {
      run.state.error = run.state.error ?? "Budget exceeded";
      deps.log?.("debug", "workflow:error-recovery", "budget exceeded, transition done", { runId: run.runId });
      let transitioned = false;
      try {
        run.transition("done", "budget_limited");
        transitioned = true;
      } catch (te) {
        void te;
      }
      if (transitioned) {
        deps.store.save(run).catch((e) => {
          const m = e instanceof Error ? e.message : String(e);
          logger2.error(`[workflow] store.save failed (budget done): ${m}`);
        });
        deps.log?.("debug", "workflow:error-recovery", "run saved after budget done", { runId: run.runId, reason: run.state.reason });
        try {
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
          deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
          deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
          deps.onRunDone?.(run);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logger2.error(`[workflow] onRunDone/emit failed (budget done): ${m}`);
        }
      }
    }
  }).catch((err) => {
    if (err instanceof Error && err.name === "AbortError") return;
    const message = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
    node.live = void 0;
    if (isOrphanedCall(run, msg.callId, call)) {
      deps.log?.("debug", "workflow:error-recovery", "orphan agent call failure dropped", { runId: run.runId, callId: msg.callId });
      return;
    }
    const errorResult = { content: "", error: message };
    if (call.status !== "done") {
      if (call.status === "pending") call.markRunning();
      call.markDone(errorResult);
    }
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    postAgentResult(run, msg.callId, errorResult, false);
    postBudgetUpdate(run);
    deps.store.save(run).catch((e) => {
      logger2.error(`[workflow] store.save failed (catch fallback): ${e instanceof Error ? e.message : String(e)}`);
    });
  });
}
function makeSerializeFailedResult(prefix, errMsg) {
  return { content: "", error: `${prefix}: ${errMsg}` };
}
function dispatchWorkflowCall(run, msg, deps) {
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) || typeof msg.name !== "string" || typeof msg.args !== "object" || msg.args === null) {
    logger2.error(`[workflow] malformed workflow-call message: callId=${JSON.stringify(msg.callId)}, name=${JSON.stringify(msg.name)}`);
    return;
  }
  const postResult = (result) => {
    if (run.state.status !== "running") return;
    try {
      run.runtime?.worker.postMessage({
        type: "workflow-result",
        callId: msg.callId,
        result
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger2.error(`[workflow] postResult (workflow-call callId=${msg.callId}) failed: ${errMsg}. Sending error fallback.`);
      try {
        run.runtime?.worker.postMessage({
          type: "workflow-result",
          callId: msg.callId,
          result: makeSerializeFailedResult("Workflow result serialization failed", errMsg)
        });
      } catch {
        logger2.error(`[workflow] postResult fallback also failed (callId=${msg.callId}): worker pending will hang until timeout`);
      }
    }
  };
  if (!deps.onWorkflowCall) {
    postResult({
      content: "",
      error: `workflow() not supported: onWorkflowCall not injected`
    });
    return;
  }
  void deps.onWorkflowCall(msg.name, msg.args, run).then(postResult).catch((err) => {
    postResult({
      content: "",
      error: err instanceof Error ? err.message : String(err)
    });
  });
}
function postAgentResult(run, callId, result, cached) {
  try {
    run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] postAgentResult failed (callId=${callId}): ${msg}. Result likely contains non-cloneable value.`);
    try {
      run.runtime?.worker.postMessage({
        type: "agent-result",
        callId,
        result: makeSerializeFailedResult("Result serialization failed", msg),
        // 原 result 不可克隆时 cached 透传原值含义失真（fallback result 非缓存命中）→ 固定 false
        cached: false
      });
    } catch {
      logger2.error(`[workflow] postAgentResult fallback also failed (callId=${callId}): worker pending will hang until timeout`);
    }
  }
}
function postBudgetUpdate(run) {
  try {
    run.runtime?.worker.postMessage({
      type: "budget-update",
      budget: {
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger2.error(`[workflow] postBudgetUpdate failed: ${msg}. Budget sync to worker skipped (non-critical).`);
  }
}
async function handleReturn(run, msg, deps) {
  deps.log?.("debug", "workflow:error-recovery", "handleReturn", { runId: run.runId, status: run.state.status });
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs.push(...msg.workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  run.state.scriptResult = msg.result;
  run.transition("done", "completed");
  await saveRunBestEffort(run, deps, "handleReturn (done,completed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after return", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function handleWorkerError(run, err, deps, handlers) {
  if (isTerminal(run)) return;
  if (run.runtime?.receivedTerminalMessage) return;
  if (run.runtime) run.runtime.receivedTerminalMessage = true;
  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;
  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }
  run.state.error = err.message;
  deps.log?.("debug", "workflow:error-recovery", "handleWorkerError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await saveRunBestEffort(run, deps, "handleWorkerError (done,failed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after worker error", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function handleWorkerExit(run, code, handle, deps, handlers) {
  if (!handle.isCurrent) return;
  if (isTerminal(run)) return;
  if (code === 0) {
    if (run.runtime?.receivedTerminalMessage) return;
    deps.log?.("debug", "workflow:error-recovery", "worker exited without terminal message, transition done", { runId: run.runId });
    run.state.error = WORKER_EXITED_WITHOUT_RESULT_MSG;
    run.transition("done", "failed");
    await saveRunBestEffort(run, deps, "handleWorkerExit (done,failed, no terminal message)");
    deps.log?.("debug", "workflow:error-recovery", "run saved after exit without result", { runId: run.runId, reason: run.state.reason });
    deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
    deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
    deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
    deps.onRunDone?.(run);
    return;
  }
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers
  );
}
async function handleScriptError(run, errorMsg, workerLogs, deps, handlers) {
  if (isTerminal(run)) return;
  if (workerLogs.length > 0) {
    run.state.errorLogs.push(...workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  const count = (run.meta.scriptErrorCount ?? 0) + 1;
  run.meta.scriptErrorCount = count;
  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }
  run.state.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
  deps.log?.("debug", "workflow:error-recovery", "handleScriptError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await saveRunBestEffort(run, deps, "handleScriptError (done,failed)");
  deps.log?.("debug", "workflow:error-recovery", "run saved after script error", { runId: run.runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}
async function scheduleRebuild(run, deps, handlers) {
  const retryIndex = Math.max(
    run.meta.workerErrorCount ?? 0,
    run.meta.scriptErrorCount ?? 0
  );
  await delay2(backoffDelay2(retryIndex));
  if (isTerminal(run)) return;
  const remainingMs = remainingTimeBudgetMs(run);
  if (remainingMs !== void 0 && remainingMs <= 0) {
    await finalizeTimeBudgetExhausted(run, deps);
    return;
  }
  rebuildRuntime(run, deps, handlers);
}

// src/orchestration/models/budget.ts
var INPUT_WEIGHT = 1;
var CACHE_READ_WEIGHT = 0.02;
var CACHE_WRITE_WEIGHT = 0;
var OUTPUT_WEIGHT = 2;
var Budget = class {
  maxTokens;
  maxCost;
  maxTimeMs;
  usedTokens = 0;
  usedCost = 0;
  /** 总调用计数（持久化/诊断用；execute-agent-call 每次 dispatch 后 increment）。 */
  totalCallCount = 0;
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens;
    this.maxCost = opts.maxCost;
    this.maxTimeMs = opts.maxTimeMs;
    this.usedTokens = opts.usedTokens ?? 0;
    this.usedCost = opts.usedCost ?? 0;
    this.totalCallCount = opts.totalCallCount ?? 0;
  }
  /**
  * 累加一次 agent 调用的 usage（加权口径）。
  *
  * 四项 token 按各自权重（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT）折算后求和，
  * 而非原始 token 数直接相加。retry 间的真实消耗如实记录，避免预算被低估。
  * 详见上方权重常量的口径说明。
  */
  consume(usage) {
    const numOrZero = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    this.usedTokens += numOrZero(usage.input) * INPUT_WEIGHT + numOrZero(usage.output) * OUTPUT_WEIGHT + numOrZero(usage.cacheRead) * CACHE_READ_WEIGHT + numOrZero(usage.cacheWrite) * CACHE_WRITE_WEIGHT;
    this.usedCost += numOrZero(usage.cost);
  }
  /** 累加调用计数（每次 agent dispatch 后调用；持久化快照同步）。 */
  incrementCallCount() {
    this.totalCallCount += 1;
  }
  /**
  * 是否超 token / cost 预算（FR-3）。
  *
  * maxTokens===0 或 undefined 视为不限制（守卫）；
  * maxCost===0 或 undefined 视为不限制。
  * 时间预算（maxTimeMs）不由本方法判断——它是 wall-clock 约束，需参照 startedAt，
  * 由 lifecycle 层的 scheduleTimeBudget（runWorkflow 内 setTimeout）
  * 独立调度，到期 abortRun(doneReason="time_limited")。
  */
  isExceeded() {
    if (this.maxTokens !== void 0 && this.maxTokens > 0 && this.usedTokens >= this.maxTokens) {
      return true;
    }
    return this.maxCost !== void 0 && this.maxCost > 0 && this.usedCost >= this.maxCost;
  }
  /**
  * 剩余 token 预算。maxTokens 未设或 ≤0 时返回 undefined（视为不限制）。
  *
  * 嵌套 workflow() 调用时由 executeNestedWorkflow 消费：子 run 的 budgetTokens
  * 继承父 run 的剩余预算，实现父子预算隔离下的总量约束。
  */
  remaining() {
    if (this.maxTokens === void 0 || this.maxTokens <= 0) return void 0;
    return Math.max(0, this.maxTokens - this.usedTokens);
  }
};

// src/orchestration/models/trace.ts
var TRACE_RESULT_MAX_CHARS = 8e3;
var TRIM_HEAD_CHARS = 4e3;
var TRIM_TAIL_CHARS = 4e3;
function trimTraceResult(result) {
  if (result === void 0) return result;
  const { content } = result;
  if (content.length <= TRACE_RESULT_MAX_CHARS) return result;
  const trimmed = content.slice(0, TRIM_HEAD_CHARS) + `
\u2026[trace result truncated, original ${content.length} chars]\u2026
` + content.slice(-TRIM_TAIL_CHARS);
  return { ...result, content: trimmed };
}
var Trace = class _Trace {
  nodes = [];
  /** stepIndex 倒排索引（查询加速 O(1)；值与 nodes 元素引用共享）。 */
  byIndex = /* @__PURE__ */ new Map();
  /**
  * 从已有节点数组重建 Trace（用于 RunStore 反序列化重水合）。
  *
  * 防御性拷贝——传入数组不被持有，外部 mutation 不影响 Trace。
  * 不验证节点顺序/唯一性（调用方保证快照来源可信）。
  * 不做裁剪——落盘快照已是 write 路径裁剪后形态，旧版本未裁剪长
  * content 重水合保持原样（read 路径无二次信息损失）。
  * 重水合后 call.traceNode（来自快照 calls[].traceNode，
  * jsonl-run-store.ts:156 直接传入）与 Trace.nodes 副本非同引用——
  * D-10 引用共享仅 live append 路径成立。
  */
  static fromArray(nodes) {
    const trace = new _Trace();
    for (const node of nodes) {
      const copy = { ...node };
      trace.nodes.push(copy);
      trace.byIndex.set(copy.stepIndex, copy);
    }
    return trace;
  }
  /**
  * Append a trace node（append-only，不改已有节点）。
  *
  * 入口裁剪：超长 result.content 先 mutate 入参节点的 result 字段，
  * 再 push 原节点引用（禁止 push 副本——保持 AgentCall.traceNode 与
  * Trace.nodes 共享同一引用的 D-10 不变式）。
  */
  append(node) {
    node.result = trimTraceResult(node.result);
    this.nodes.push(node);
    this.byIndex.set(node.stepIndex, node);
  }
  /**
  * Update a trace node by stepIndex (callId) with a partial patch.
  *
  * 只改 patch 中提供的字段（status/result/error/completedAt/sessionId）。
  * stepIndex 不存在时 no-op（防御性——agent 完成/失败回调可能晚于 run 终止到达）。
  */
  update(stepIndex, patch) {
    const node = this.findByStepIndex(stepIndex);
    if (!node) return;
    if (patch.status !== void 0) node.status = patch.status;
    if (patch.result !== void 0) node.result = trimTraceResult(patch.result);
    if (patch.error !== void 0) node.error = patch.error;
    if (patch.completedAt !== void 0) node.completedAt = patch.completedAt;
    if (patch.sessionId !== void 0) node.sessionId = patch.sessionId;
    if (patch.sessionFile !== void 0) node.sessionFile = patch.sessionFile;
  }
  /**
  * 查找指定 stepIndex 的节点（byIndex O(1)，trace 中 stepIndex 应唯一）。
  *
  * 语义差异声明（旧线性扫 first-match → Map last-wins）：仅在破坏
  * stepIndex 唯一性的违规使用下可见，两组场景——
  * 1. 重复 append 同 stepIndex 且未 remove：返回最后一个节点（last-wins；
  *    旧线性扫 first-match 会返回第一个）。
  * 2. 重复 append 后 removeByStepIndex：remove 的 findIndex 命中首个旧节点
  *    splice，而 byIndex.delete 把整个 stepIndex 键删掉——nodes 残留第二个
  *    节点成为孤儿（find/update 不可达，length/toArray 仍可见）。
  * 合法路径无差异：唯一性由 discard 先 remove 再 append 保证（W1TC12 锚定）。
  */
  findByStepIndex(stepIndex) {
    return this.byIndex.get(stepIndex);
  }
  /** 按节点引用删除（仅用于测试或 run 重建场景；正常运行不调用）。 */
  find(stepIndex) {
    return this.findByStepIndex(stepIndex);
  }
  /**
  * 按 stepIndex 移除节点（崩溃重建清理在飞 call 用）。
  *
  * 正常运行不调用（append-only 不变式）。仅 error-recovery 的 discardInFlightCalls
  * （rebuildRuntime 内，F2）清理被旧 runtime abort 的在飞 call 时用——移除其 trace
  * 节点，让重跑重发 agent-call 时 append 全新节点走全新执行路径（避免 stale
  * "running" 节点残留 + trace.update 命中旧节点导致新节点 orphan）。
  * stepIndex 不存在时 no-op（防御性）。
  */
  removeByStepIndex(stepIndex) {
    const idx = this.nodes.findIndex((n) => n.stepIndex === stepIndex);
    if (idx === -1) return;
    this.nodes.splice(idx, 1);
    this.byIndex.delete(stepIndex);
  }
  /**
  * readonly 视图——返回内部 nodes 数组引用（仅类型级 readonly，运行时无
  * 防御）。消费方禁止结构化 mutate（push/splice/重排/覆盖元素）：byIndex
  * 引入后外部结构化 mutate 会使 nodes 与倒排索引 desync。字段级变更走 update()。
  */
  toArray() {
    return this.nodes;
  }
  /** 当前节点数。 */
  get length() {
    return this.nodes.length;
  }
};

// src/orchestration/models/types.ts
var VALID_RUN_TRANSITIONS = {
  running: ["done"],
  done: []
};
function canRunTransition(from, to) {
  return VALID_RUN_TRANSITIONS[from].includes(to);
}

// src/orchestration/models/workflow-run.ts
var WorkflowRun = class _WorkflowRun {
  runId;
  spec;
  state;
  runtime;
  meta;
  /**
  * 创建聚合根。初始状态 "running"（一次性生命周期：run 从创建起即在执行，
  * runtime 由紧随其后的 assignRuntime 注入）。也可传入 done 状态用于重水合
  * 已完成的 run（loadAll 后的只读聚合）。
  *
  * 不变式 I1 构造期跳过——「创建即 running」要求构造瞬间 runtime===undefined
  * 合法（runtime 必须由 assignRuntime 注入，构造函数无从持有）；重水合的
  * running 快照同样无 worker。I1 的运行时校验在 assignRuntime/transition/
  * replaceRuntime 末尾的 validateInvariants 处生效。
  */
  constructor(runId, spec, state, meta) {
    this.runId = runId;
    this.spec = spec;
    this.state = state;
    this.meta = meta;
    this.runtime = void 0;
    this.validateInvariantI2();
  }
  /**
  * 从持久化快照重水合聚合根。与构造函数同语义（构造期跳过 I1——持久化的
  * running 状态没有 worker，进程被杀后 worker 不可能还活着）。保留独立工厂
  * 标注重水合意图；调用方（D-4 kill-9 恢复）负责在 session_start 时把残留
  * running 转 done,failed，恢复 I1。
  *
  * @throws I2 违反（done 快照缺 reason 仍是 bug，不可跳过）
  */
  static reconstruct(runId, spec, state, meta) {
    return new _WorkflowRun(runId, spec, state, meta);
  }
  // ── 不变式校验 ─────────────────────────────────────────────
  /**
  * 校验不变式 I1 + I2。违反抛错（聚合根自我保护，fail-fast）。
  * 在每个 mutation 方法末尾调用（防御式编程 + 测试可断言）。
  */
  validateInvariants() {
    this.validateInvariantI2();
    if (this.state.status === "running" && this.runtime === void 0) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status==="running" but runtime is undefined (runId=${this.runId})`
      );
    }
    if (this.state.status !== "running" && this.runtime !== void 0) {
      throw new Error(
        `WorkflowRun invariant I1 violated: status!=="running" but runtime is defined (runId=${this.runId})`
      );
    }
  }
  /**
  * 仅校验不变式 I2（done ⟹ reason）。构造期用——「创建即 running」与重水合的
  * running 快照都无 runtime（I1 构造期跳过），但 I2 必须保证（done 缺 reason 是真 bug）。
  */
  validateInvariantI2() {
    if (this.state.status === "done" && this.state.reason === void 0) {
      throw new Error(
        `WorkflowRun invariant I2 violated: status==="done" but reason is undefined (runId=${this.runId})`
      );
    }
  }
  // ── 状态机转换 ─────────────────────────────────────────────
  /**
  * 状态机转换。合法转换：running→done。
  *
  * running 的进入不走 transition——构造即 running，replaceRuntime 保持 running。
  * 调用 transition("running") 抛错，防止绕过 runtime 注入直接改状态。
  *
  * 副作用：
  * - →done: releaseRuntime + 设 state.reason + meta.completedAt
  *
  * @param target 目标状态（不允许 "running"——runtime 注入只走 assignRuntime/replaceRuntime）
  * @param reason →done 时必填（done ⟹ reason，不变式 I2）
  * @throws 非法转换 / done 缺 reason / target==="running"
  */
  transition(target, reason) {
    if (target === "running") {
      throw new Error(
        `WorkflowRun.transition: cannot transition to "running" directly \u2014 use assignRuntime() (runId=${this.runId})`
      );
    }
    if (!canRunTransition(this.state.status, target)) {
      throw new Error(
        `WorkflowRun.transition: illegal transition ${this.state.status} \u2192 ${target} (runId=${this.runId})`
      );
    }
    if (target === "done" && reason === void 0) {
      throw new Error(
        `WorkflowRun.transition: transition to "done" requires a reason (runId=${this.runId})`
      );
    }
    this.releaseRuntime();
    this.state.status = target;
    this.state.reason = reason;
    this.meta.completedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.validateInvariants();
  }
  // ── Runtime 生命周期 ───────────────────────────────────────
  /**
  * 绑定 runtime（run 创建后注入执行资源）。
  *
  * 前置：status==="running" && runtime===undefined（runWorkflow 创建路径——
  * 构造即 running 但 runtime 延迟到此处注入）。
  * 原子地：设 runtime 后末尾 validateInvariants，恢复构造期跳过的 I1
  * （running ⟺ runtime!==undefined）。
  *
  * @throws runtime 已定义 / status 不是 "running"（done 僵尸不可复活）
  */
  assignRuntime(rt) {
    if (this.runtime !== void 0) {
      throw new Error(
        `WorkflowRun.assignRuntime: runtime already defined (runId=${this.runId})`
      );
    }
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.assignRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`
      );
    }
    this.runtime = rt;
    this.validateInvariants();
  }
  /**
  * 解绑 runtime（done 时由 transition 调用，也可独立调用）。
  *
  * 前置：无（runtime===undefined 时 no-op，幂等）。
  * 副作用：调 runtime.release("terminal") 释放 worker/controller，置 runtime=undefined。
  */
  releaseRuntime() {
    if (this.runtime === void 0) return;
    this.runtime.release("terminal");
    this.runtime = void 0;
  }
  /**
  * 原地替换 runtime（G5-001：worker-error-retry）。
  *
  * 前置：status==="running"（G6-001：终态 run 拒绝重建）。
  * 原子地：释放旧 runtime（worker.terminate + abort）+ 绑定新 runtime，
  * 全程 status 保持 "running"，不变式 I1 不违反（中间无 runtime===undefined 可见态）。
  *
  * 与 release+assign 的区别：replaceRuntime 不改 status，中间同步完成，
  * 外部观察不到违反不变式的瞬间。
  *
  * @throws status!=="running"
  */
  replaceRuntime(rt) {
    if (this.state.status !== "running") {
      throw new Error(
        `WorkflowRun.replaceRuntime: requires status==="running" (current: ${this.state.status}, runId=${this.runId})`
      );
    }
    if (this.runtime !== void 0) {
      this.runtime.release("terminal");
    }
    this.runtime = rt;
    this.validateInvariants();
  }
};

// src/orchestration/lifecycle.ts
var logger3 = getLogger("subagents");
var RUNID_RADIX = 36;
var RUNID_SLICE_START = 2;
var RUNID_SLICE_END = 8;
var MAX_RETAINED_DONE_RUNS = 20;
function generateRunId() {
  return `wf-${Date.now()}-${Math.random().toString(RUNID_RADIX).slice(RUNID_SLICE_START, RUNID_SLICE_END)}`;
}
function makeHandlers(run, deps) {
  const handlers = {
    async onMessage(raw) {
      await handleWorkerMessage(run, raw, deps, handlers);
    },
    async onError(err) {
      await handleWorkerError(run, err, deps, handlers);
    },
    async onExit(code, handle) {
      await handleWorkerExit(run, code, handle, deps, handlers);
    }
  };
  return handlers;
}
function scheduleTimeBudget(runId, deps, budgetTimeMs) {
  assertSafeTimerDelay(budgetTimeMs, "budgetTimeMs");
  const timer = setTimeout(() => {
    void abortRun(runId, deps, "Time budget exceeded", "time_limited").catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger3.error(`[workflow] time budget abort failed: ${msg}`);
      }
    );
  }, budgetTimeMs);
  timer.unref();
  return timer;
}
async function runWorkflow(spec, deps, signal) {
  validateRunArgs(spec);
  const runId = generateRunId();
  if (spec.args && typeof spec.args === "object") {
    spec.args._runId = runId;
  }
  deps.log?.("debug", "workflow:lifecycle", "runWorkflow start", { runId, scriptName: spec.scriptName });
  if (signal?.aborted) {
    throw new Error("Workflow run aborted before start");
  }
  const run = new WorkflowRun(
    runId,
    spec,
    {
      status: "running",
      budget: spec.budgetRef ?? new Budget({
        maxTokens: spec.budgetTokens,
        maxTimeMs: spec.budgetTimeMs
      }),
      calls: /* @__PURE__ */ new Map(),
      trace: new Trace(),
      errorLogs: []
    },
    { startedAt: (/* @__PURE__ */ new Date()).toISOString() }
  );
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        void abortRun(runId, deps, "External signal aborted").catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger3.error(`[workflow] abortRun on signal failed: ${msg}`);
        });
      },
      { once: true }
    );
  }
  const handlers = makeHandlers(run, deps);
  const controller = new AbortController();
  const worker = deps.workerHost.start(spec, spec.args, handlers);
  const timeBudgetTimer = spec.budgetTimeMs && spec.budgetTimeMs > 0 ? scheduleTimeBudget(runId, deps, spec.budgetTimeMs) : void 0;
  const runtime = new RunRuntime(worker, controller, timeBudgetTimer);
  run.assignRuntime(runtime);
  deps.runs.set(runId, run);
  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "run saved", { runId, status: run.state.status });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register", { runId });
  deps.eventBus?.emit("pending:register", {
    id: runId,
    type: "workflow",
    name: spec.slug || spec.scriptName || runId
  });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:register done", { runId });
  return runId;
}
async function abortRun(runId, deps, reason, doneReason = "aborted") {
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(`Workflow '${runId}' not found`);
  }
  deps.log?.("debug", "workflow:lifecycle", "abortRun", { runId, status: run.state.status, reason, doneReason });
  if (run.state.status === "done") {
    deps.log?.("debug", "workflow:lifecycle", "abortRun no-op: already done", { runId });
    return;
  }
  if (reason) {
    run.state.error = reason;
  }
  run.transition("done", doneReason);
  await deps.store.save(run);
  deps.log?.("debug", "workflow:lifecycle", "abortRun transition done", { runId, reason: run.state.reason });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister", { runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:lifecycle", "emit pending:unregister done", { runId });
  deps.onRunDone?.(run);
}
async function terminateRunningRuns(deps, reason) {
  for (const run of deps.runs.values()) {
    if (run.state.status !== "running") continue;
    try {
      deps.log?.("debug", "workflow:lifecycle", "terminateRunningRuns", { runId: run.runId, reason });
      run.state.error = reason;
      run.transition("done", "failed");
      await deps.store.save(run);
      deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: "failed" });
      deps.log?.("debug", "workflow:lifecycle", "run terminated", { runId: run.runId, reason: run.state.reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger3.error(
        `[workflow] terminateRunningRuns failed for run ${run.runId}: ${msg} (reason: ${reason})`
      );
    }
  }
}
function evictDoneRunsBeyondCap(runs, keepDone) {
  const done = Array.from(runs.values()).filter((r) => r.state.status === "done");
  const excess = done.length - keepDone;
  if (excess <= 0) return 0;
  const keyOf = (r) => r.meta.completedAt ?? "";
  done.sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  for (const r of done.slice(0, excess)) {
    runs.delete(r.runId);
  }
  return excess;
}

// src/orchestration/launcher.ts
var STATUS_POLL_INTERVAL_MS = 500;
var RUN_WATCHDOG_ENV = "XYZ_SUBAGENT_RUN_WATCHDOG_MS";
function getEnvRunWatchdogMs() {
  const raw = process.env[RUN_WATCHDOG_ENV];
  if (!raw) return void 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return void 0;
  return parsed;
}
function pollInterval() {
  return new Promise((resolve4) => {
    const timer = setTimeout(resolve4, STATUS_POLL_INTERVAL_MS);
    timer.unref?.();
  });
}
function toResult(run) {
  return {
    status: "done",
    reason: run.state.reason ?? "failed",
    scriptResult: run.state.scriptResult,
    error: run.state.error,
    runId: run.runId
  };
}
async function pollRunToResult(runId, deps, signal, timeoutMs, abortReason) {
  const explicitTimeoutMs = timeoutMs !== void 0 && timeoutMs > 0 ? timeoutMs : getEnvRunWatchdogMs();
  if (explicitTimeoutMs !== void 0) {
    assertSafeTimerDelay(explicitTimeoutMs, `timeoutMs / ${RUN_WATCHDOG_ENV}`);
  }
  const deadline = explicitTimeoutMs === void 0 ? Number.POSITIVE_INFINITY : Date.now() + explicitTimeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const runBeforeAbort = deps.runs.get(runId);
      if (runBeforeAbort?.state.status === "done") return toResult(runBeforeAbort);
      await safeAbort(runId, deps, abortReason, "aborted");
      const run2 = deps.runs.get(runId);
      return run2 ? toResult(run2) : { status: "done", reason: "aborted", error: abortReason, runId };
    }
    const run = deps.runs.get(runId);
    if (!run) return { status: "done", reason: "failed", error: "Run not found", runId };
    if (run.state.status === "done") return toResult(run);
    await pollInterval();
  }
  const runBeforeTimeout = deps.runs.get(runId);
  if (runBeforeTimeout?.state.status === "done") return toResult(runBeforeTimeout);
  await safeAbort(runId, deps, `Workflow timed out after ${explicitTimeoutMs}ms`, "time_limited");
  const finalRun = deps.runs.get(runId);
  return finalRun ? toResult(finalRun) : {
    status: "done",
    reason: "time_limited",
    error: `Workflow timed out after ${explicitTimeoutMs}ms`,
    runId
  };
}
async function runAndWait(name, args, deps, signal, timeoutMs) {
  const script = await deps.registry.getPath(name);
  if (!script) {
    return {
      status: "done",
      reason: "failed",
      error: `Workflow '${name}' not found`,
      runId: ""
    };
  }
  const lintResult = script.validate();
  if (!lintResult.valid) {
    const errors = lintResult.findings.filter((f) => f.severity === "error").map((f) => `L${f.line}: ${f.message}`).join("; ");
    throw new Error(`Workflow script '${name}' has lint errors: ${errors}`);
  }
  const spec = {
    scriptSource: script.toExecutable(),
    args,
    budgetTokens: void 0,
    scriptName: script.name,
    scriptPath: script.path,
    description: script.meta.description,
    parameters: script.meta.parameters
  };
  let runId;
  try {
    runId = await runWorkflow(spec, deps, signal);
  } catch (err) {
    if (err instanceof ArgsValidationError) {
      return {
        status: "done",
        reason: "invalid_args",
        runId: "",
        error: err.message
      };
    }
    throw err;
  }
  return pollRunToResult(runId, deps, signal, timeoutMs, "Aborted by signal");
}
async function safeAbort(runId, deps, reason, doneReason) {
  try {
    await abortRun(runId, deps, reason, doneReason);
  } catch (err) {
    void err;
  }
}
async function executeNestedWorkflow(name, args, parentRun, deps) {
  const chain = [
    ...parentRun.spec.parentWorkflowChain ?? [],
    parentRun.spec.scriptName
  ];
  if (chain.includes(name)) {
    return {
      content: "",
      error: `Circular workflow call detected: ${[...chain, name].join(" \u2192 ")}`
    };
  }
  const childController = new AbortController();
  const parentSignal = parentRun.runtime?.controller.signal;
  const onParentAbort = () => childController.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      childController.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  try {
    const script = await deps.registry.getPath(name);
    if (!script) {
      return { content: "", error: `Workflow '${name}' not found` };
    }
    const lintResult = script.validate();
    if (!lintResult.valid) {
      const errors = lintResult.findings.filter((f) => f.severity === "error").map((f) => `L${f.line}: ${f.message}`).join("; ");
      return {
        content: "",
        error: `Workflow script '${name}' has lint errors: ${errors}`
      };
    }
    const spec = {
      scriptSource: script.toExecutable(),
      args,
      budgetRef: parentRun.state.budget,
      // Run-level override 传播（与父 run 对齐）：子 run 继承父 run 的 model/thinkingLevel，
      // 否则嵌套 workflow 丢失父 run 的模型指定，回落主 agent 模型。
      model: parentRun.spec.model,
      thinkingLevel: parentRun.spec.thinkingLevel,
      scriptName: script.name,
      scriptPath: script.path,
      description: script.meta.description,
      parameters: script.meta.parameters,
      parentWorkflowChain: chain
    };
    const runId = await runWorkflow(spec, deps, childController.signal);
    const rawNestedTimeoutMs = parentRun.spec.budgetTimeMs;
    const nestedTimeoutMs = rawNestedTimeoutMs !== void 0 && rawNestedTimeoutMs > 0 ? rawNestedTimeoutMs : void 0;
    const result = await pollRunToResult(
      runId,
      deps,
      childController.signal,
      nestedTimeoutMs,
      "Aborted by parent signal"
    );
    if (result.reason === "completed") {
      const scriptResult = result.scriptResult;
      return {
        content: typeof scriptResult === "string" ? scriptResult : JSON.stringify(scriptResult ?? ""),
        parsedOutput: typeof scriptResult === "object" && scriptResult !== null ? scriptResult : void 0
      };
    }
    return {
      content: "",
      error: result.error ?? `Workflow '${name}' ended: ${result.reason}`
    };
  } catch (err) {
    if (err instanceof ArgsValidationError) {
      return { content: "", error: err.message };
    }
    throw err;
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// src/orchestration/worker-host.ts
var import_node_worker_threads = require("worker_threads");

// src/orchestration/worker-handle.ts
var WorkerHandle = class {
  worker;
  /**
  * 竞态守卫。true = 此 handle 仍是当前活动 handle；false = 已 terminate，
  * 后续事件（已终止 worker 延迟触发的 message/error/exit）必须忽略。
  *
  * 终止后置 false 并永不回升（幂等语义）。新 handle 由调用方（WorkerHost）
  * 重新创建，已终止 handle 留在内存里直到 GC，但其回调全部 no-op。
  */
  current = true;
  constructor(worker) {
    this.worker = worker;
  }
  /** 此 handle 是否仍是当前活动 handle（terminate 后 false，G-025）。 */
  get isCurrent() {
    return this.current;
  }
  /** 底层 Worker（WorkerHost/RunRuntime 偶尔需要直接访问，如 ref/href）。 */
  get raw() {
    return this.worker;
  }
  /**
  * 向 worker 发送消息。terminate 后 no-op（已终止 handle 的 postMessage 无意义）。
  */
  postMessage(msg) {
    if (!this.current) return;
    this.worker.postMessage(msg);
  }
  /**
  * 终止 worker 线程。幂等——重复调用安全，第二次起 no-op。
  * 置 isCurrent=false 后再 await worker.terminate，确保并发 exit 事件
  * 在 terminate resolve 之前到达时也被守卫拦下。
  */
  async terminate() {
    if (!this.current) return;
    this.current = false;
    try {
      await this.worker.terminate();
    } catch (err) {
      void err;
    }
  }
  /**
  * 绑定 message 回调。仅当 isCurrent 时触发——已终止 handle 的事件被吞掉。
  * 返回 this 便于链式 onMessage(...).onError(...).onExit(...)。
  */
  onMessage(handler) {
    this.worker.on("message", (raw) => {
      if (!this.current) return;
      handler(raw);
    });
    return this;
  }
  /**
  * 绑定 error 回调。仅当 isCurrent 时触发。
  */
  onError(handler) {
    this.worker.on("error", (err) => {
      if (!this.current) return;
      handler(err);
    });
    return this;
  }
  /**
  * 绑定 exit 回调。仅当 isCurrent 时触发——这是 G-025 的关键守卫：
  * terminate(old) → startWorker(new) → old exit 触发时，old handle.current
  * 已为 false，回调 no-op，不会误删 new worker。
  */
  onExit(handler) {
    this.worker.on("exit", (code) => {
      if (!this.current) return;
      handler(code);
    });
    return this;
  }
};

// src/orchestration/worker-script-builder.ts
var WORKER_TEMPLATE_PRE = [
  '"use strict";',
  "// Module-scope helpers: accessible to BOTH the IIFE body AND the outer",
  "// .then()/.catch() handlers (which run outside the IIFE). _workerLogs/",
  "// _pushWorkerLog/_safePost + the parentPort/workerData handles must all live",
  "// here \u2014 a previous version declared _safePost inside the IIFE, so the",
  "// .then()/.catch() return/error handlers threw ReferenceError: _safePost is",
  "// not defined, crashing the Worker on EVERY script return (exit code 1) and",
  "// losing all diagnostics. require() is cached, so destructuring once at module",
  "// load and reusing everywhere avoids the redundant require calls that used to",
  "// appear in the IIFE and the outer .then/.catch.",
  'const { parentPort: _parentPort, workerData: _workerData } = require("node:worker_threads");',
  "const _workerLogs = [];",
  "// IF6(#12): known agent() fields \u2014 hoisted to module scope, built once per worker",
  "// (was rebuilt inside agent() on every call; field set is call-invariant).",
  'const _KNOWN_FIELDS = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "maxTurns", "cwd", "fork", "worktree", "returnMeta", "thinkingLevel", "engine"]);',
  "function _pushWorkerLog(level, args) {",
  '  try { _workerLogs.push({ level, message: args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") }); } catch (e) { /* swallow */ }',
  "}",
  "// \u2500\u2500 safePostMessage wrapper: \u7EDF\u4E00 postMessage \u9632\u5FA1\uFF08DataCloneError \u7B49\uFF09\u2500\u2500",
  "// Module-scope so the outer .then/.catch return/error handlers can use it.",
  "// context \u53D6\u503C\u7EA6\u5B9A\uFF08\u8BCA\u65AD\u6807\u8BC6\uFF09\uFF1A\u56FA\u5B9A\u4E3A\u6D88\u606F\u7C7B\u578B\u5B57\u9762\u91CF\u2014\u2014",
  '// "agent-call" / "workflow-call" / "return" / "error"\uFF0C\u8C03\u7528\u65B9\u636E\u6B64\u5728\u65E5\u5FD7\u91CC',
  "// \u4E00\u773C\u5B9A\u4F4D\u662F\u54EA\u7C7B postMessage \u5931\u8D25\u3002\u65B0\u589E\u8C03\u7528\u70B9\u5FC5\u987B\u4F20\u5BF9\u5E94 context\u3002",
  "function _safePost(msg, context) {",
  "  try { _parentPort.postMessage(msg); return true; }",
  "  catch (e) {",
  "    const errMsg = e && e.message ? e.message : String(e);",
  '    const stack = e && e.stack ? e.stack : "";',
  '    _pushWorkerLog("error", ["[postMessage failed:" + context + "]", errMsg, stack]);',
  "    return false;",
  "  }",
  "}",
  "(async () => {",
  "  const parentPort = _parentPort;",
  "  const workerData = _workerData;",
  "",
  "  if (!parentPort) {",
  '    throw new Error("Workflow worker: parentPort is null \u2014 not running in a Worker thread");',
  "  }",
  "",
  "  // \u2500\u2500 Intercept console.* to avoid leaking worker diagnostics into the input area \u2500\u2500",
  '  console.log = function (...args) { _pushWorkerLog("log", args); };',
  '  console.warn = function (...args) { _pushWorkerLog("warn", args); };',
  '  console.error = function (...args) { _pushWorkerLog("error", args); };',
  '  console.info = function (...args) { _pushWorkerLog("info", args); };',
  "",
  "  // \u2500\u2500 Internal state \u2500\u2500",
  "  let _callIdCounter = 0;",
  "  let _agentCallCount = 0;",
  "  const _pendingCalls = new Map();",
  "  const _callCache = workerData.callCache instanceof Map",
  "    ? workerData.callCache",
  "    : new Map(Object.entries(workerData.callCache || {}).map(([k, v]) => [Number(k), v]));",
  "",
  "  // \u2500\u2500 Injected globals \u2500\u2500",
  '  const $ARGS = (workerData.args && typeof workerData.args === "object") ? workerData.args : {};\n  const args = $ARGS;',
  '  const $WORKSPACE = typeof workerData.workspace === "string" ? workerData.workspace : "";',
  "  const _budgetData = {",
  "    total: (workerData.budget && workerData.budget.maxTokens) || 0,",
  "    _spentTokens: (workerData.budget && workerData.budget.usedTokens) ?? 0,",
  "    _spentCost: (workerData.budget && workerData.budget.usedCost) ?? 0,",
  "  };",
  "  const $BUDGET = {",
  "    get total() { return _budgetData.total; },",
  "    spent() { return _budgetData._spentTokens; },",
  "    remaining() { return Math.max(0, _budgetData.total - _budgetData._spentTokens); },",
  "  };",
  "",
  "  // \u2500\u2500 Run-level model/thinkingLevel override (Option B symmetric single-path) \u2500\u2500",
  "  // Injected from workerData (set by workerHost from RunSpec.model/thinkingLevel).",
  "  // agent() reads these as run-level defaults; per-call explicit opts still win.",
  '  const $MODEL = (workerData.model && typeof workerData.model === "string") ? workerData.model : undefined;',
  '  const $THINKING_LEVEL = (workerData.thinkingLevel && typeof workerData.thinkingLevel === "string") ? workerData.thinkingLevel : undefined;',
  "",
  "  // \u2500\u2500 WorkflowAbortedError \u2500\u2500",
  "  class WorkflowAbortedError extends Error {",
  "    constructor(reason) {",
  '      super("Workflow aborted: " + (reason || "No reason"));',
  '      this.name = "WorkflowAbortedError";',
  '      this.reason = reason || "";',
  "    }",
  "  }",
  "",
  "  // \u2500\u2500 Message handler (main thread \u2192 worker) \u2500\u2500",
  '  parentPort.on("message", (msg) => {',
  '    if (msg.type === "agent-result") {',
  "      const pending = _pendingCalls.get(msg.callId);",
  "      if (pending) {",
  "        _pendingCalls.delete(msg.callId);",
  '        if (typeof msg.result !== "undefined") {',
  "          _callCache.set(msg.callId, msg.result);",
  "        }",
  "        // \u5931\u8D25\u4E0D\u4F20\u64AD\u5230 agent \u5916\u90E8\uFF1Aresolve \u800C\u975E reject\u3002",
  "        // \u65E7\u5B9E\u73B0\u5728 result.error \u65F6 reject\uFF0C\u5355 agent \u5931\u8D25\u4F1A\u5192\u5230 worker \u9876\u5C42 .catch()",
  '        // \u2192 \u53D1 type:"error" \u2192 handleScriptError \u2192 rebuildRuntime \u2192 SIGKILL \u540C\u4F34\u8FDB\u7A0B\uFF0C',
  "        // \u628A\u5355\u70B9\u5931\u8D25\u653E\u5927\u6210\u6574\u6279\u5D29\u6E83\u3002\u6539\u4E3A\u59CB\u7EC8 resolve\uFF08\u9519\u8BEF\u65F6\u56DE\u9000\u5230 content \u6587\u672C\uFF09\uFF0C",
  "        // \u8BA9 parallel() \u4E0B\u7684\u811A\u672C\u5BB9\u9519\u5FAA\u73AF\uFF08parseResult \u2192 null \u2192 skip\uFF09\u81EA\u7136\u63A5\u7BA1\u3002",
  "        // \u9519\u8BEF\u539F\u56E0\u5DF2\u7531\u4E3B\u7EBF\u7A0B executeAgentCall \u2192 trace.update(result.error) \u4FDD\u7559\u5728 trace/TUI\uFF0C",
  "        // \u4E0D\u4E22\u5931\u3002\u5931\u8D25 resolve \u4E3A\u7A7A\u5B57\u7B26\u4E32\u662F\u65E2\u5B9A\u5BB9\u9519\u7B56\u7565\u3002",
  "        // [MF-4] schema \u6A21\u5F0F\u4E0B\u5931\u8D25\u65F6 agent() \u4ECD resolve\uFF08content \u56DE\u9000\u3001\u4E0D throw\uFF09\u2014\u2014",
  "        // \u9700\u8981\u68C0\u67E5\u9519\u8BEF\u65F6\u8BF7\u7528 returnMeta:true\uFF08resolve \u503C\u542B error \u5B57\u6BB5\uFF09\u3002",
  "        // parsedOutput: validated data object from structured-output execute().",
  "        // Fallback to content (raw text) when no schema was requested or on error.",
  "        // W2 \u6539\u52A8 9(b)\uFF1AreturnMeta===true \u65F6 resolve {value,sessionFile,worktreePath,error,usage,durationMs,sessionId}",
  "        // \uFF08\u5BF9\u79F0\u7F13\u5B58\u91CD\u653E 9c\uFF09\uFF1B\u5426\u5219\u5355\u503C\u3002usage/durationMs/sessionId \u4E3A rfl \u4EEA\u8868\u900F\u4F20\uFF08tier-1 \xA77.1\uFF0C",
  "        // AgentResult \u5DF2\u542B\u3001\u6B64\u5904\u539F\u6837\u8F6C\u53D1\uFF0C\u7F3A\u7701 undefined \u517C\u5BB9\u65E7\u4E3B\u7EBF\u7A0B\uFF09\u3002",
  "        const _value = msg.result.parsedOutput ?? msg.result.content;",
  "        if (pending.returnMeta) {",
  "          pending.resolve({",
  "            value: _value,",
  "            sessionFile: msg.result.sessionFile,",
  "            worktreePath: msg.result.worktreePath,",
  "            error: msg.result.error,",
  "            usage: msg.result.usage,",
  "            durationMs: msg.result.durationMs,",
  "            sessionId: msg.result.sessionId,",
  "          });",
  "        } else {",
  "          pending.resolve(_value);",
  "        }",
  "      }",
  '    } else if (msg.type === "workflow-result") {',
  "      const pending = _pendingCalls.get(msg.callId);",
  "      if (pending) {",
  "        _pendingCalls.delete(msg.callId);",
  "        pending.resolve(msg.result);",
  "      }",
  '    } else if (msg.type === "abort") {',
  "      const err = new WorkflowAbortedError(msg.reason);",
  "      _pendingCalls.forEach((p) => { p.reject(err); });",
  "      _pendingCalls.clear();",
  '    } else if (msg.type === "budget-update" && msg.budget) {',
  "      _budgetData._spentTokens = msg.budget.usedTokens ?? _budgetData._spentTokens;",
  "      _budgetData._spentCost = msg.budget.usedCost ?? _budgetData._spentCost;",
  "    }",
  '    // "budget-warning" is informational; no required handling',
  "  });",
  "",
  // ── phase global ──
  '  let _currentPhase = "";',
  "  function phase(name) { _currentPhase = String(name); }",
  "",
  // ── log global ──
  "  function log(msg) {",
  '    try { parentPort.postMessage({ type: "log", phase: _currentPhase, message: String(msg) }); } catch(e) { /* swallow */ }',
  "  }",
  "",
  // ── agent global — CC-compatible multi-signature ──
  "  async function agent(firstArg, secondArg) {",
  "    let opts;",
  '    if (typeof firstArg === "string") {',
  "      opts = {",
  "        prompt: firstArg,",
  '        description: (secondArg && typeof secondArg === "object" && secondArg.label) || undefined,',
  '        schema: (secondArg && typeof secondArg === "object" && secondArg.schema) || undefined,',
  '        model: (secondArg && typeof secondArg === "object" && secondArg.model) || $MODEL,',
  '        scene: (secondArg && typeof secondArg === "object" && secondArg.scene) || undefined,\n        phase: (secondArg && typeof secondArg === "object" && secondArg.phase) || undefined,',
  '        thinkingLevel: (secondArg && typeof secondArg === "object" && secondArg.thinkingLevel) || $THINKING_LEVEL,',
  "        // step \u7EA7 turn \u4E0A\u9650\uFF08turn limiter\uFF1B\u663E\u5F0F 0/\u8D1F = \u663E\u5F0F\u4E0D\u9650\uFF0C\u538B\u8FC7 spawn watchdog env \u5151\u5E95\uFF0CSP-6\uFF09\n        // ?? \u8BED\u4E49\u4FDD\u771F\uFF1A\u4EC5 null/undefined \u5F52 undefined\uFF08\u8D70 env \u5151\u5E95\uFF09\uFF0C\u663E\u5F0F 0 \u4FDD\u7559\uFF08U5 \u53C2\u6570 > env\uFF09",
  '        maxTurns: (secondArg && typeof secondArg === "object" ? secondArg.maxTurns : undefined) ?? undefined,',
  "        // P4 D9\u2462\uFF1Astep \u7EA7 engine \u663E\u5F0F\u6307\u5B9A\uFF08\u4EC5\u9650\u5FC5\u987B\u67D0\u5F15\u64CE\u72EC\u6709\u80FD\u529B\u7684\u573A\u666F\uFF09",
  '        engine: (secondArg && typeof secondArg === "object" && secondArg.engine) || undefined,',
  "      };",
  '    } else if (typeof firstArg === "object" && firstArg !== null) {',
  "      if (firstArg.prompt) {",
  "        opts = firstArg;",
  "      } else if (firstArg.task || firstArg.agent) {",
  "        // fork/worktree/returnMeta forwarded here (parity with agent({prompt,...}) and direct-pass",
  "        // branches). Previously this shortcut dropped them (w1 only noted, not wired).",
  "        opts = {",
  '          prompt: firstArg.task || firstArg.prompt || "",',
  "          description: firstArg.label || firstArg.description,",
  "          agent: firstArg.agent,",
  "          schema: firstArg.schema,",
  "          model: firstArg.model || $MODEL,",
  "          scene: firstArg.scene,",
  "          skill: firstArg.skill,",
  "          timeoutMs: firstArg.timeoutMs,",
  "          maxTurns: firstArg.maxTurns,",
  "          cwd: firstArg.cwd,",
  "          fork: firstArg.fork,",
  "          worktree: firstArg.worktree,",
  "          returnMeta: firstArg.returnMeta,",
  "          thinkingLevel: firstArg.thinkingLevel || $THINKING_LEVEL,",
  "          engine: firstArg.engine,",
  "        };",
  "      } else {",
  "        opts = firstArg;",
  "      }",
  "    } else {",
  '      throw new Error("agent() requires a prompt string or options object as first argument");',
  "    }",
  "",
  "    // Run-level fallback for object branches (opts = firstArg direct assign).",
  "    // Priority: agent() explicit > $MODEL global (set from workerData.model).",
  "    if (!opts.model && $MODEL) opts.model = $MODEL;",
  "    if (!opts.thinkingLevel && $THINKING_LEVEL) opts.thinkingLevel = $THINKING_LEVEL;",
  "",
  "    // Validate known agent() fields to catch API misuse early (_KNOWN_FIELDS at module scope)",
  "    const _unknownFields = Object.keys(opts).filter((k) => !_KNOWN_FIELDS.has(k));",
  "    if (_unknownFields.length > 0) {",
  '      _pushWorkerLog("warn", ["[workflow] agent() received unknown fields: " + _unknownFields.join(", ") + ". Known fields: prompt, description, schema, model, scene, label, task, agent, phase, skill, timeoutMs, maxTurns, cwd, fork, worktree, returnMeta, thinkingLevel, engine"]);',
  "    }",
  "",
  "    const callId = _callIdCounter;",
  "    _callIdCounter++;",
  "    _agentCallCount++;",
  "    if (_callCache.has(callId)) {",
  "      const cached = _callCache.get(callId);",
  "      // \u4E0E live handler \u5BF9\u9F50\uFF1A\u5931\u8D25\u4E5F resolve\uFF08\u56DE\u9000 content\uFF09\uFF0C\u4E0D throw\u3002",
  "      // \u89C1 agent-result \u6D88\u606F\u5904\u7406\u7684\u6CE8\u91CA\uFF1A\u62D2\u7EDD\u4F20\u64AD\u5931\u8D25\u5230 agent \u5916\u90E8\u3002",
  "      // W2 \u6539\u52A8 9(c)\uFF1AreturnMeta \u5206\u652F\uFF08\u5BF9\u79F0 handler 9b\uFF09\uFF0Copts \u4ECD\u5728\u95ED\u5305\u4F5C\u7528\u57DF\u3002",
  "      if (!cached) return undefined;",
  "      const _cachedValue = cached.parsedOutput ?? cached.content;",
  "      if (opts.returnMeta === true) {",
  "        return {",
  "          value: _cachedValue,",
  "          sessionFile: cached.sessionFile,",
  "          worktreePath: cached.worktreePath,",
  "          error: cached.error,",
  "          usage: cached.usage,",
  "          durationMs: cached.durationMs,",
  "          sessionId: cached.sessionId,",
  "        };",
  "      }",
  "      return _cachedValue;",
  "    }",
  "",
  '    const _effectivePhase = opts.phase || _currentPhase;\n    delete opts.phase;\n\n    if (!_safePost({ type: "agent-call", callId, opts, phase: _effectivePhase }, "agent-call")) {',
  '      return Promise.reject(new Error("postMessage failed for agent-call (callId=" + callId + "): see workerLogs"));',
  "    }",
  "    return new Promise((resolve, reject) => {",
  "      _pendingCalls.set(callId, { resolve, reject, returnMeta: opts.returnMeta === true });",
  "    });",
  "  }",
  "",
  // ── parallel global — CC-compatible ──
  // allSettled 语义：单个 agent 的意外 reject（postMessage 失败等基础设施异常、abort）
  // 不拖垮整批。rejected 结果降级为错误消息字符串（与 agent() 的 error→content 回退一致，
  // parseResult(string) → null → 脚本 soft-fail）。B1 之后 agent() 不再因 agent 失败 reject，
  // 这里作为纵深防御保留。
  //
  // **Promise 项处理**：CC-compatible 写法 `parallel([agent({...}), ...])` 传入的是已实例化
  // 的 Promise 数组（agent() 同步返回 Promise）。Promise 是 object 但无 .then 鸭辨分支时
  // 会落到 `agent(c)` 把 Promise 当 opts 传 → postMessage DataCloneError。必须在函数/opts
  // 分支前用 thenable 鸭辨直接返回 in-flight Promise，让 allSettled 接管。
  "  async function parallel(calls) {",
  '    if (typeof calls === "function") { return calls(); }',
  "    const settled = await Promise.allSettled(calls.map((c) => {",
  '      if (c && typeof c.then === "function") { return c; }',
  '      if (typeof c === "function") { return c(); }',
  '      if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }',
  "      return agent(c);",
  "    }));",
  "    return settled.map((r) => {",
  '      if (r.status === "fulfilled") {',
  "        const v = r.value;",
  '        if (v !== null && typeof v === "object" && !Array.isArray(v)) {',
  "          // \u4E3B\u7EBF\u7A0B fallback\uFF08postAgentResult/postResult serialization failed\uFF09\u56DE\u53D1\u7684\u5BF9\u8C61\u542B error \u5B57\u6BB5",
  '          // \u2192 \u5F52\u4E00\u5316\u4E3A failed \u5F62\u72B6\uFF0C\u4E0E\u811A\u672C\u4FA7 r.status === "failed" \u68C0\u67E5\u7EDF\u4E00',
  '          if (typeof v.error === "string" && v.error.length > 0) return { status: "failed", error: v.error };',
  "          return v;",
  "        }",
  '        return { status: "failed", error: "agent returned non-object result (type=" + typeof v + ")" };',
  "      }",
  "      const reason = r.reason;",
  "      const errMsg = reason instanceof Error ? reason.message : String(reason);",
  '      return { status: "failed", error: errMsg };',
  "    });",
  "  }",
  "",
  // ── pipeline global ──
  "  async function pipeline(firstArg, ...restStages) {",
  "    // Single-arg mode: pipeline([stage1, stage2, ...])",
  "    if (Array.isArray(firstArg) && restStages.length === 0) {",
  "      let result;",
  "      for (let i = 0; i < firstArg.length; i++) {",
  "        try { result = await firstArg[i](result); }",
  "        catch (e) {",
  "          const msg = e && e.message ? e.message : String(e);",
  '          _pushWorkerLog("error", ["[pipeline stage " + i + " failed]", msg]);',
  "          throw e;",
  "        }",
  "      }",
  "      return result;",
  "    }",
  "    // Cartesian product mode: pipeline([items], stage1, stage2, ...)",
  '    if (Array.isArray(firstArg) && restStages.length > 0 && typeof restStages[0] === "function") {',
  "      const results = [];",
  "      for (let idx = 0; idx < firstArg.length; idx++) {",
  "        const item = firstArg[idx];",
  "        let val = item;",
  "        let failed = false;",
  "        for (const stage of restStages) {",
  "          if (failed) break;",
  "          try { val = await stage(val); }",
  "          catch (e) {",
  "          const msg = e && e.message ? e.message : String(e);",
  '          _pushWorkerLog("error", ["[pipeline cartesian stage failed for item " + (idx + 1) + "]", msg]);',
  "          val = null; failed = true;",
  "          }",
  "        }",
  "        results.push(val);",
  "      }",
  "      return results;",
  "    }",
  '    throw new Error("pipeline() expects pipeline([stage1, ...]) or pipeline([items], stage1, ...)");',
  "  }",
  "",
  "  // \u2500\u2500 workflow global \u2014 nested workflow invocation \u2500\u2500",
  "  async function workflow(name, args) {",
  '    if (typeof name !== "string" || name.length === 0) {',
  '      throw new Error("workflow() requires a workflow name string as first argument");',
  "    }",
  '    const workflowArgs = (typeof args === "object" && args !== null) ? args : {};',
  "    const callId = _callIdCounter;",
  "    _callIdCounter++;",
  '    if (!_safePost({ type: "workflow-call", callId, name, args: workflowArgs }, "workflow-call")) {',
  '      return Promise.reject(new Error("postMessage failed for workflow-call (name=" + name + "): see workerLogs"));',
  "    }",
  "    return new Promise((resolve, reject) => {",
  "      _pendingCalls.set(callId, { resolve, reject });",
  "    });",
  "  }",
  "",
  "  // \u2500\u2500 User workflow script \u2500\u2500"
].join("\n");
var WORKER_TEMPLATE_POST = [
  "  // \u2500\u2500 Auto-invoke execute() for module.exports pattern \u2500\u2500",
  '  if (typeof module !== "undefined" && module.exports && typeof module.exports.execute === "function") {',
  "    return await module.exports.execute({ agent, parallel, pipeline, phase, log, workflow, $ARGS, $WORKSPACE, $BUDGET });",
  "  }",
  "})().then((result) => {",
  '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
  '  if (!_safePost({ type: "return", runId, result, workerLogs: _workerLogs }, "return")) {',
  "    // [F1] return \u503C\u4E0D\u53EF\u514B\u9686\uFF08\u542B function/Symbol/\u5FAA\u73AF\u5F15\u7528 \u2192 DataCloneError\uFF09\u65F6 _safePost",
  "    // \u53EA\u80FD\u8BB0\u65E5\u5FD7\u8FD4\u56DE false\u2014\u2014\u82E5\u4E0D\u8865\u6551\uFF0Cworker \u5C06\u9759\u9ED8 exit(0)\uFF0C\u4E3B\u7EBF\u7A0B\u6536\u4E0D\u5230\u4EFB\u4F55\u7EC8\u6001\u6D88\u606F\uFF0C",
  "    // run \u6C38\u4E45 running\u3001runAndWait \u60AC\u6302\u3002\u56DE\u53D1\u53EF\u514B\u9686\u7684 error \u6D88\u606F\uFF08DataCloneError \u8BE6\u60C5",
  "    // \u5DF2\u7531 _safePost \u8BB0\u5165 _workerLogs \u968F\u6D88\u606F\u5E26\u56DE\uFF09\uFF0C\u8BA9\u4E3B\u7EBF\u7A0B handleScriptError \u63A5\u7BA1\uFF0C",
  "    // run \u7ECF\u65E2\u6709\u91CD\u8BD5\u77E9\u9635\u6536\u655B\u5230\u7EC8\u6001 failed\u3002",
  '    _safePost({ type: "error", runId, error: "Workflow return value could not be delivered (structured-clone failed) \u2014 see workerLogs for the postMessage error", workerLogs: _workerLogs }, "error");',
  "  }",
  "}).catch((err) => {",
  '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
  '  _safePost({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs }, "error");',
  "});"
].join("\n");
function buildWorkerScript(userScript) {
  return WORKER_TEMPLATE_PRE + "\n  " + userScript + "\n\n" + WORKER_TEMPLATE_POST;
}

// src/orchestration/worker-host.ts
var WorkerHostImpl = class {
  /**
  * 启动一个 Worker thread 运行 workflow 脚本。
  *
  * 1. 用 buildWorkerScript(spec.scriptSource) 包装用户脚本（注入 agent/parallel/
  * pipeline/$ARGS/$BUDGET 等全局，AC-4 格式契约由 buildWorkerScript 保证）
  * 2. new Worker(code, { eval: true, workerData })（C.2 修复：eval 内联源码，
  * 不 require bootstrap 文件）
  * 3. 包装为 WorkerHandle，绑定 onMessage/onError/onExit 回调到 handlers
  * 4. onExit 传 handle 给 handlers.onExit(code, handle)（C.3 修复——调用方用
  * handle.isCurrent 做竞态防护，G-025）
  *
  * 返回的 WorkerHandle 由调用方（lifecycle）保存到 RunRuntime.worker。
  * 终止/崩溃重建（rebuild）时由 RunRuntime.release 接管。
  */
  start(spec, args, handlers) {
    const workerCode = buildWorkerScript(spec.scriptSource);
    const worker = new import_node_worker_threads.Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath: spec.scriptPath,
        args,
        workspace: process.cwd(),
        meta: {
          name: spec.scriptName,
          description: spec.description
        },
        // D-12 regression fix (round-2 #1)：注入 budget，否则 worker 内 $BUDGET.total 恒为 0。
        // 旧 agent-call-handler.ts 删除时同时丢失了 budget 注入和 budget-update 发送方，
        // 导致依赖 $BUDGET 做动态预算分支的脚本静默得到全 0。
        budget: {
          maxTokens: spec.budgetTokens,
          usedTokens: 0,
          usedCost: 0
        },
        // Option B symmetric single-path: model/thinkingLevel flow through
        // workerData → $MODEL/$THINKING_LEVEL worker globals (injected by
        // worker-script-builder) → agent() fallback. Not merged into args.
        model: spec.model,
        thinkingLevel: spec.thinkingLevel
      }
    });
    const handle = new WorkerHandle(worker);
    handle.onMessage((raw) => {
      void handlers.onMessage(raw);
    });
    handle.onError((err) => {
      void handlers.onError(err);
    });
    handle.onExit((code) => {
      void handlers.onExit(code, handle);
    });
    return handle;
  }
};

// src/shared/meta-parser.ts
var import_yaml = __toESM(require_dist(), 1);
var WORKFLOW_META_RE = /\/\*\s*@pi-meta\s*\n([\s\S]*?)\n\*\//;
var FRONTMATTER_RE = /---\r?\n([\s\S]*?)\r?\n---/;
function extractBlock(content, kind) {
  const re = kind === "workflow" ? WORKFLOW_META_RE : FRONTMATTER_RE;
  return re.exec(content)?.[1];
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isString(v) {
  return typeof v === "string";
}
function isPlainObject2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function typecheckMeta(raw, kind) {
  if (!isPlainObject2(raw)) return null;
  const o = raw;
  if (!isNonEmptyString(o.name)) return null;
  if (!isString(o.description)) return null;
  const when = isString(o.when) ? o.when : void 0;
  const notFor = isString(o.notFor) ? o.notFor : void 0;
  if (kind === "workflow") {
    if (o.examples !== void 0 || o.tools !== void 0 || o.model !== void 0 || o.engine !== void 0) {
      return null;
    }
    if (!Array.isArray(o.phases)) return null;
    const phases = [];
    for (const p of o.phases) {
      if (isString(p)) {
        phases.push(p);
      } else if (isPlainObject2(p) && isNonEmptyString(p.title)) {
        if (p.detail !== void 0 && !isString(p.detail)) return null;
        phases.push(isString(p.detail) ? { title: p.title, detail: p.detail } : { title: p.title });
      } else {
        return null;
      }
    }
    const parameters = o.parameters;
    if (parameters !== void 0 && !isPlainObject2(parameters)) return null;
    const usage = isString(o.usage) ? o.usage : void 0;
    const meta2 = {
      kind: "workflow",
      name: o.name,
      description: o.description,
      phases,
      ...parameters !== void 0 ? { parameters } : {},
      ...usage !== void 0 ? { usage } : {},
      ...when !== void 0 ? { when } : {},
      ...notFor !== void 0 ? { notFor } : {}
    };
    return meta2;
  }
  if (o.phases !== void 0 || o.parameters !== void 0 || o.usage !== void 0) return null;
  let examples;
  if (o.examples !== void 0) {
    if (!Array.isArray(o.examples)) return null;
    const exs = [];
    for (const e of o.examples) {
      if (isPlainObject2(e) && isString(e.match) && isString(e.action) && typeof e.positive === "boolean") {
        exs.push({ match: e.match, action: e.action, positive: e.positive });
      } else {
        return null;
      }
    }
    examples = exs;
  }
  let tools;
  if (o.tools !== void 0) {
    if (Array.isArray(o.tools)) {
      if (!o.tools.every(isString)) return null;
      tools = o.tools;
    } else if (isString(o.tools)) {
      const parts = o.tools.split(",").map((s) => s.trim()).filter(Boolean);
      tools = parts.length > 0 ? parts : void 0;
    } else {
      return null;
    }
  }
  const model = isString(o.model) ? o.model : void 0;
  const engine = isString(o.engine) ? o.engine : void 0;
  const meta = {
    kind: "agent",
    name: o.name,
    description: o.description,
    ...examples !== void 0 ? { examples } : {},
    ...tools !== void 0 ? { tools } : {},
    ...model !== void 0 ? { model } : {},
    ...engine !== void 0 ? { engine } : {},
    ...when !== void 0 ? { when } : {},
    ...notFor !== void 0 ? { notFor } : {}
  };
  return meta;
}
function parseResourceMeta(content, kind) {
  const block = extractBlock(content, kind);
  if (block === void 0) return null;
  try {
    const raw = (0, import_yaml.parse)(block);
    return typecheckMeta(raw, kind);
  } catch {
    return null;
  }
}

// src/orchestration/script-lint.ts
var DESC_MAX_LENGTH = 200;
var ENTRY_POINT_PATTERNS = [/\bagent\s*\(/, /\bparallel\s*\(/, /\bpipeline\s*\(/];
function checkEntryPoint(source) {
  const hasEntryPoint = ENTRY_POINT_PATTERNS.some((p) => p.test(source));
  if (hasEntryPoint) return [];
  return [
    {
      severity: "error",
      line: 0,
      message: "Workflow script must call agent(), parallel(), or pipeline() at least once.",
      suggestion: "Add at least one agent(), parallel(), or pipeline() invocation."
    }
  ];
}
function checkLine(lineText, lineNum) {
  const results = [];
  const trimmed = lineText.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return results;
  }
  const resultAccessPatterns = [
    { regex: /\bresult\s*\.\s*output\b/, field: "output" },
    { regex: /\bresult\s*\.\s*parsedOutput\b/, field: "parsedOutput" },
    { regex: /\bresult\s*\.\s*content\b/, field: "content" }
  ];
  for (const p of resultAccessPatterns) {
    if (p.regex.test(lineText)) {
      results.push({
        severity: "error",
        line: lineNum,
        message: `\`result.${p.field}\` does not exist. agent() returns the unwrapped value directly.`,
        suggestion: "Use `const value = await agent(...)` and access `value` directly."
      });
    }
  }
  if (/readFileSync\(.*STATE.*\)|readFileSync\(.*state.*\.json/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "Reading a state file between agent calls is fragile (subprocess file access).",
      suggestion: "Use agent() with `schema` to get structured output directly, avoiding file I/O for state passing."
    });
  }
  if (/unlinkSync.*state/i.test(lineText)) {
    results.push({
      severity: "warning",
      line: lineNum,
      message: "unlinkSync in finally may race with agent subprocess file reads.",
      suggestion: "Avoid file-based state passing; use agent() `schema` for structured output."
    });
  }
  return results;
}
function stripStringsAndComments(line) {
  return line.replace(/"(?:\\.|[^"\\])*"/g, "").replace(/'(?:\\.|[^'\\])*'/g, "").replace(/`(?:\\.|[^`\\])*`/g, "").replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function forEachAgentCallRange(source, callback) {
  const lines = source.split("\n");
  let inAgentCall = false;
  let depth = 0;
  let agentStartLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    const codeLine = stripStringsAndComments(line);
    if (!inAgentCall && /\bagent\s*\(/.test(codeLine)) {
      inAgentCall = true;
      depth = 0;
      agentStartLine = i;
      const afterAgent = codeLine.replace(/^.*?\bagent\s*\(/, "(");
      const argTail = afterAgent.trimStart().slice(1).trimStart();
      if (argTail.length > 0 && !argTail.startsWith("{")) {
        inAgentCall = false;
        continue;
      }
      for (const ch of afterAgent) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") depth--;
      }
      if (depth <= 0) {
        callback(agentStartLine, i);
        inAgentCall = false;
      }
      continue;
    }
    if (inAgentCall) {
      for (const ch of codeLine) {
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        if (ch === ")" || ch === "}" || ch === "]") depth--;
      }
      if (depth <= 0) {
        callback(agentStartLine, i);
        inAgentCall = false;
      }
    }
  }
}
function checkAgentCalls(source) {
  const lines = source.split("\n");
  const findings = [];
  forEachAgentCallRange(source, (startLine, endLine) => {
    checkAgentCallOptions(lines, startLine, endLine, findings);
  });
  return findings;
}
function checkAgentCallOptions(lines, startLine, endLine, findings) {
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];
    if (/\b(?:const|let|var)\s+outputSchema\b/.test(line)) {
      continue;
    }
    if (/\boutputSchema\s*[,\}]/.test(line) || /\boutputSchema\s*:/.test(line)) {
      const beforeOutput = line.substring(0, line.indexOf("outputSchema"));
      if (/:\s*$/.test(beforeOutput)) {
        continue;
      }
      findings.push({
        severity: "error",
        line: i + 1,
        message: "`outputSchema` is not a valid agent() option.",
        suggestion: "Use `schema` instead of `outputSchema`."
      });
    }
  }
}
function stripSchemaBlocks(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = text.slice(i).match(/\bschema\s*:\s*\{/);
    if (!m || m.index === void 0) {
      out += text.slice(i);
      break;
    }
    const start = i + m.index;
    const braceIdx = start + m[0].lastIndexOf("{");
    out += text.slice(i, start);
    let depth = 0;
    let j = braceIdx;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}
function checkAgentDescription(source) {
  const lines = source.split("\n");
  const findings = [];
  forEachAgentCallRange(source, (startLine, endLine) => {
    const range = stripSchemaBlocks(lines.slice(startLine, endLine + 1).map(stripStringsAndComments).join("\n"));
    if (/\{\s*\.\.\./.test(range)) return;
    if (!/\b(description|label)\s*:/.test(range)) {
      findings.push({
        severity: "warning",
        line: startLine + 1,
        message: "agent() call without `description` (or `label`) will show as '(unnamed)' in TUI.",
        suggestion: "Add `description: 'kebab-case-name'` to agent() opts for readable /workflows display."
      });
    }
  });
  return findings;
}
var BARE_ASYNC_IIFE_PATTERN = /(^|[;\n\s{}(])(?<!await\s)\(async\s+(?:function\b|\(\)|\([^)]*\)\s*=>)/g;
function isIIFEAwaited(source, iifeStart) {
  let i = iifeStart - 1;
  while (i >= 0) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i--;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      return true;
    }
    if (ch === "=" || ch === "(" || ch === "[" || ch === "," || ch === "?" || ch === ":") {
      return true;
    }
    if (ch === ";" || ch === "{" || ch === "}" || ch === ")") {
      return false;
    }
    return true;
  }
  return false;
}
function checkBareAsyncIIFE(source) {
  if (!ENTRY_POINT_PATTERNS.some((p) => p.test(source))) return [];
  const findings = [];
  for (const match of source.matchAll(BARE_ASYNC_IIFE_PATTERN)) {
    const iifeStart = match.index ?? 0;
    const finding = analyzeIIFE(source, iifeStart);
    if (finding) findings.push(finding);
  }
  return findings;
}
function analyzeIIFE(source, iifeStart) {
  const iifeLine = source.slice(0, iifeStart).split("\n").length;
  const firstBrace = source.indexOf("{", iifeStart);
  if (firstBrace === -1) return void 0;
  let depth = 0;
  let iifeEnd = -1;
  for (let i = firstBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        iifeEnd = i;
        break;
      }
    }
  }
  if (iifeEnd === -1) return void 0;
  const iifeBody = source.slice(firstBrace, iifeEnd);
  const hasAgentInside = ENTRY_POINT_PATTERNS.some((p) => p.test(iifeBody));
  if (!hasAgentInside) return void 0;
  const awaited = isIIFEAwaited(source, iifeStart);
  if (awaited) {
    return {
      severity: "warning",
      line: iifeLine,
      message: "Async IIFE wrapping agent() is assigned/returned but must be awaited. If the surrounding context does not await this Promise, the worker will post `return` early and kill in-flight agent() subprocesses.",
      suggestion: "Verify the surrounding code awaits this IIFE's Promise. When unsure, prefer top-level await directly (the worker already wraps your script in an async IIFE)."
    };
  }
  return {
    severity: "error",
    line: iifeLine,
    message: "Top-level async IIFE is a fire-and-forget statement. The worker's outer IIFE will post `return` before agent() resolves, killing the subprocess via runtime abort.",
    suggestion: "Remove the IIFE wrapper and use top-level await directly (the worker already wraps your script in an async IIFE). Or `await` the IIFE: `await (async function main() { ... })();`."
  };
}
function checkMetaPhases(source) {
  const findings = [];
  for (const m of source.matchAll(/phases\s*:\s*\[\s*\{/g)) {
    if (m.index === void 0) continue;
    const lineNum = source.slice(0, m.index).split("\n").length;
    findings.push({
      severity: "warning",
      line: lineNum,
      message: "`meta.phases` should be a string array like ['phase1','phase2']. Object arrays are ignored by the engine.",
      suggestion: "Use `phases: ['analyze','fix']`. Engine groups nodes by runtime `phase()` calls, not by `meta.phases` declarations."
    });
  }
  return findings;
}
function checkPhaseConsistency(source) {
  const findings = [];
  const declared = /* @__PURE__ */ new Map();
  const phasesArrayMatch = source.match(/phases\s*:\s*\[[^\]]*\]/);
  if (phasesArrayMatch && phasesArrayMatch.index !== void 0) {
    const inner = phasesArrayMatch[0];
    if (!/\[\s*\{/.test(inner)) {
      const phasesLine = source.slice(0, phasesArrayMatch.index).split("\n").length;
      for (const m of inner.matchAll(/['"]([^'"]+)['"]/g)) {
        if (!declared.has(m[1])) declared.set(m[1], phasesLine);
      }
    }
  }
  const called = /* @__PURE__ */ new Map();
  for (const m of source.matchAll(/\bphase\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (m.index === void 0) continue;
    const lineNum = source.slice(0, m.index).split("\n").length;
    if (!called.has(m[1])) called.set(m[1], lineNum);
  }
  if (declared.size === 0 && called.size === 0) return [];
  for (const [name, line] of declared) {
    if (!called.has(name)) {
      findings.push({
        severity: "warning",
        line,
        message: `declared phase '${name}' never set via phase().`,
        suggestion: `Add phase('${name}') before the agent() calls belonging to this phase, or remove it from meta.phases.`
      });
    }
  }
  for (const [name, line] of called) {
    if (!declared.has(name)) {
      findings.push({
        severity: "warning",
        line,
        message: `phase('${name}') called but not in meta.phases.`,
        suggestion: `Add '${name}' to meta.phases array, e.g. phases: [..., '${name}'].`
      });
    }
  }
  return findings;
}
function checkMetaFieldQuality(field, value) {
  const findings = [];
  if (value.length > DESC_MAX_LENGTH) {
    findings.push({
      severity: "error",
      line: 1,
      message: `meta.${field} \u957F\u5EA6 ${value.length} \u8D85\u8FC7 ${DESC_MAX_LENGTH} \u5B57\u7B26\uFF08\xA75.1 \u6CE8\u5165\u6BB5\u9884\u7B97\u7EA6\u675F\uFF09`,
      suggestion: "\u7CBE\u7B80\u4E3A\u5355\u53E5\u8DEF\u7531\u63CF\u8FF0\uFF0C\u7EC6\u8282\u79FB\u5165 usage"
    });
  }
  const stripped = value.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").replace(/\b(?:e\.g|i\.e)\.\s/g, "");
  if (/[\n。；]|\.\s/.test(stripped)) {
    findings.push({
      severity: "error",
      line: 1,
      message: `meta.${field} \u975E\u5355\u53E5\uFF08\u542B\u6362\u884C/\u5206\u53E5\u6807\u70B9\uFF09\u2014\u2014\xA75.1 \u6CE8\u5165\u6BB5\u8981\u6C42\u4E00\u53E5\u8BDD\u8DEF\u7531\u63CF\u8FF0`,
      suggestion: "\u7CBE\u7B80\u4E3A\u5355\u53E5\uFF0C\u7EC6\u8282\u79FB\u5165 when/notFor/usage"
    });
  }
  return findings;
}
function checkMetaQuality(meta) {
  const findings = [];
  const description = meta.description ?? "";
  const paramNames = /* @__PURE__ */ new Set();
  if (meta.parameters && typeof meta.parameters === "object") {
    const props = meta.parameters.properties;
    if (props !== null && typeof props === "object") {
      for (const k of Object.keys(props)) paramNames.add(k);
    }
    const pp = meta.parameters.patternProperties;
    if (pp !== null && typeof pp === "object") {
      for (const p of Object.keys(pp)) {
        const m = p.match(/^\^([a-zA-Z]+)\\d\+\$$/);
        if (m) paramNames.add(m[1]);
      }
    }
  }
  const fields = [
    ["description", description],
    ["when", meta.when ?? ""],
    ["notFor", meta.notFor ?? ""]
  ];
  for (const [field, value] of fields) {
    if (value.length === 0) continue;
    for (const name of paramNames) {
      const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${nameEsc}:\\s`).test(value) || new RegExp(`\\b${nameEsc}=\\S`).test(value)) {
        findings.push({
          severity: "error",
          line: 1,
          message: `meta.${field} \u5305\u542B\u5DF2\u58F0\u660E\u53C2\u6570\u540D '${name}'\uFF08'${name}:' / '${name}=' \u5F62\u6001\uFF09\u2014\u2014\u53C2\u6570\u5951\u7EA6\u8BF7 read \u811A\u672C\u6587\u4EF6\u7684 @pi-meta parameters \u67E5\u8BE2\uFF0Cdescription/when/notFor \u53EA\u653E\u8DEF\u7531\u4FE1\u606F`,
          suggestion: `\u4ECE meta.${field} \u79FB\u9664 '${name}: ...' / '${name}=...'\uFF0C\u6539\u5728 parameters/usage \u4E2D\u58F0\u660E`
        });
      }
    }
    findings.push(...checkMetaFieldQuality(field, value));
  }
  return findings;
}
function lintScript(source) {
  const lines = source.split("\n");
  const findings = [];
  findings.push(...checkEntryPoint(source));
  for (let i = 0; i < lines.length; i++) {
    findings.push(...checkLine(lines[i], i + 1));
  }
  findings.push(...checkAgentCalls(source));
  findings.push(...checkBareAsyncIIFE(source));
  const meta = parseResourceMeta(source, "workflow");
  if (meta && meta.kind === "workflow") {
    findings.push(...checkMetaQuality(meta));
  }
  findings.push(...checkAgentDescription(source));
  findings.push(...checkMetaPhases(source));
  findings.push(...checkPhaseConsistency(source));
  findings.sort((a, b) => a.line - b.line);
  return {
    valid: !findings.some((f) => f.severity === "error"),
    findings
  };
}

// src/orchestration/models/workflow-script.ts
var lintMemo = /* @__PURE__ */ new Map();
function clearLintMemo() {
  lintMemo.clear();
}
var WorkflowScript = class {
  name;
  source;
  path;
  /** 原始文件内容（可编辑）。toExecutable 返回 strip 后的副本，不改本字段。 */
  sourceCode;
  meta;
  /** false 当 meta 提取失败（loader 不抛错，标记不可用但仍列出）。 */
  available;
  constructor(opts) {
    this.name = opts.name;
    this.source = opts.source;
    this.path = opts.path;
    this.sourceCode = opts.sourceCode;
    this.meta = opts.meta;
    this.available = opts.available;
  }
  /**
  * 静态检查脚本合法性。
  *
  * 委托 engine/script-lint.ts 的 lintScript——检查项含：
  * - 必须含 agent/parallel/pipeline 入口之一
  * - agent 选项 outputSchema → schema
  * - result.output/parsedOutput/content 不存在
  * - 文件传状态警告
  *
  * IF9（#15）：同 path 且 sourceCode 引用相等 → 返回缓存 lint 结果（launcher 嵌套
  * 场景下 registry 重建实例的重复全量 lint 消除）；否则 lint + 覆写条目。
  */
  validate() {
    const memoized = lintMemo.get(this.path);
    if (memoized && memoized.srcRef === this.sourceCode) {
      return memoized.result;
    }
    const result = lintScript(this.sourceCode);
    lintMemo.set(this.path, { srcRef: this.sourceCode, result });
    return result;
  }
  /**
  * 返回可执行源。
  *
  * m2：不再 strip `export const meta`——meta 现为 @pi-meta 块注释（合法 JS，
  * worker 天然忽略），无 const meta 变量。toExecutable 返回原文（含块注释）。
  * Worker 线程 wrap（注入 globals）由 infra/worker-script-builder.ts buildWorkerScript 完成。
  */
  toExecutable() {
    return this.sourceCode;
  }
};

// src/shared/resource-discovery.ts
var fsSync = __toESM(require("fs"), 1);
var import_promises = require("fs/promises");
var import_node_os2 = require("os");
var import_node_path2 = require("path");
var logger4 = getLogger("subagents");
var shadowWarnDedup = /* @__PURE__ */ new Set();
var MAX_SHADOW_WARN_DEDUP = 1024;
var MACHINE_SOURCES = /* @__PURE__ */ new Set([
  "npm",
  "npm-dev",
  "user-extension-paths",
  "project-pi",
  "project-pi-tmp",
  "project-agents"
]);
function isMachineSource(source) {
  return MACHINE_SOURCES.has(source);
}
var WORKSPACE_ROOT_MAX_DEPTH = 20;
function isDirectChildOfWorkspaceRoot(dir, workspaceRoot) {
  return (0, import_node_path2.resolve)(dir, "..") === workspaceRoot;
}
var mtimeCache = /* @__PURE__ */ new Map();
var workspaceRootCache = /* @__PURE__ */ new Map();
var manifestCache = /* @__PURE__ */ new Map();
function piToManifest(pi, kind) {
  if (!pi) return void 0;
  const entries = pi[kind];
  if (!Array.isArray(entries)) return void 0;
  return entries.filter((p) => typeof p === "string");
}
function parsePiField(content) {
  const parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const pi = parsed.pi;
  return typeof pi === "object" && pi !== null && !Array.isArray(pi) ? pi : void 0;
}
function getCachedFile(filePath) {
  let mtimeMs;
  try {
    mtimeMs = fsSync.statSync(filePath).mtimeMs;
  } catch {
    mtimeCache.delete(filePath);
    return null;
  }
  const entry = mtimeCache.get(filePath);
  if (entry && entry.mtimeMs === mtimeMs) return entry;
  let content;
  try {
    content = fsSync.readFileSync(filePath, "utf-8");
  } catch {
    mtimeCache.delete(filePath);
    return null;
  }
  const cached = { mtimeMs, content };
  mtimeCache.set(filePath, cached);
  return cached;
}
function getCachedFileContent(filePath) {
  return getCachedFile(filePath)?.content ?? null;
}
var parsedCache = /* @__PURE__ */ new Map();
function clearFileCache() {
  mtimeCache.clear();
  workspaceRootCache.clear();
  manifestCache.clear();
  for (const perParse of parsedCache.values()) perParse.clear();
}
function findWorkspaceRoot(cwd) {
  const dir = cwd ?? process.cwd();
  const memo = workspaceRootCache.get(dir);
  if (memo !== void 0) return memo;
  const root = computeWorkspaceRoot(dir);
  workspaceRootCache.set(dir, root);
  return root;
}
function computeWorkspaceRoot(dir) {
  const root = (0, import_node_path2.resolve)("/");
  let probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync((0, import_node_path2.resolve)(probe, ".bare"))) {
      if (probe !== dir && isDirectChildOfWorkspaceRoot(dir, probe) && fsSync.existsSync((0, import_node_path2.resolve)(dir, ".pi"))) {
        return dir;
      }
      return probe;
    }
    if (probe === root) break;
    probe = (0, import_node_path2.resolve)(probe, "..");
  }
  let topLevel = dir;
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync((0, import_node_path2.resolve)(probe, ".git"))) {
      topLevel = probe;
    }
    if (probe === root) break;
    probe = (0, import_node_path2.resolve)(probe, "..");
  }
  if (topLevel !== dir) {
    return topLevel;
  }
  probe = dir;
  for (let i = 0; i < WORKSPACE_ROOT_MAX_DEPTH; i++) {
    if (fsSync.existsSync((0, import_node_path2.resolve)(probe, ".pi"))) {
      return probe;
    }
    if (probe === root) break;
    probe = (0, import_node_path2.resolve)(probe, "..");
  }
  return dir;
}
function isTargetFile(name, kind) {
  if (name.startsWith("_")) return false;
  if (kind === "agents") {
    return name.endsWith(".md") && !name.endsWith(".chain.md");
  }
  return name.endsWith(".js") || name.endsWith(".mjs");
}
function stem(filePath) {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
async function scanDirectory(dirPath, kind) {
  try {
    await (0, import_promises.access)(dirPath);
  } catch {
    return [];
  }
  const entries = await (0, import_promises.readdir)(dirPath, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!isTargetFile(e.name, kind)) continue;
    const absPath = (0, import_node_path2.resolve)(dirPath, e.name);
    if (e.isFile()) {
      files.push(absPath);
    } else if (e.isSymbolicLink()) {
      const targetStat = await (0, import_promises.stat)(absPath).catch(() => null);
      if (targetStat?.isFile()) files.push(absPath);
    }
  }
  return files;
}
async function readPackageManifest(pkgDir, kind) {
  const pkgJsonPath = (0, import_node_path2.resolve)(pkgDir, "package.json");
  let mtimeMs;
  try {
    mtimeMs = (await (0, import_promises.stat)(pkgJsonPath)).mtimeMs;
  } catch {
    manifestCache.delete(pkgJsonPath);
    return void 0;
  }
  const entry = manifestCache.get(pkgJsonPath);
  if (entry && entry.mtimeMs === mtimeMs) return piToManifest(entry.pi, kind);
  let pi;
  try {
    const content = await (0, import_promises.readFile)(pkgJsonPath, "utf-8");
    pi = parsePiField(content);
  } catch {
    return void 0;
  }
  manifestCache.set(pkgJsonPath, { mtimeMs, pi });
  return piToManifest(pi, kind);
}
async function processPackage(pkgDir, kind) {
  const manifestPaths = await readPackageManifest(pkgDir, kind);
  if (manifestPaths && manifestPaths.length > 0) {
    const results = [];
    let allFailed = true;
    for (const relPath of manifestPaths) {
      const absPath = (0, import_node_path2.resolve)(pkgDir, relPath);
      const fileStat = await (0, import_promises.stat)(absPath).catch(() => null);
      if (!fileStat) {
        results.push({ path: absPath, source: "npm", available: false });
        continue;
      }
      if (fileStat.isDirectory()) {
        const files2 = await scanDirectory(absPath, kind);
        for (const f of files2) {
          results.push({ path: f, source: "npm", available: true });
          allFailed = false;
        }
      } else if (fileStat.isFile()) {
        results.push({ path: absPath, source: "npm", available: true });
        allFailed = false;
      }
    }
    if (allFailed) {
      return results;
    }
    return results;
  }
  const conventionDir = (0, import_node_path2.resolve)(pkgDir, kind);
  const files = await scanDirectory(conventionDir, kind);
  return files.map((f) => ({ path: f, source: "npm", available: true }));
}
async function scanNpmDir(nodeModulesDir, kind) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(nodeModulesDir);
  } catch {
    return [];
  }
  const perEntry = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = (0, import_node_path2.resolve)(nodeModulesDir, entry);
      if (entry.startsWith("@")) {
        let scopedEntries;
        try {
          scopedEntries = await (0, import_promises.readdir)(entryPath);
        } catch {
          return [];
        }
        const perScoped = await Promise.all(
          scopedEntries.map((scopedPkg) => processPackage((0, import_node_path2.resolve)(entryPath, scopedPkg), kind))
        );
        return perScoped.flat();
      }
      return processPackage(entryPath, kind);
    })
  );
  return perEntry.flat();
}
function readExtensionPaths() {
  const raw = process.env.XYZ_EXTENSION_PATHS;
  if (!raw) return [];
  const paths = raw.split(import_node_path2.delimiter).map((p) => p.trim()).filter((p) => p.length > 0).map((p) => p.startsWith("~") ? (0, import_node_path2.join)((0, import_node_os2.homedir)(), p.slice(1)) : p);
  return [...new Set(paths)];
}
function buildScanTargets(config) {
  const { kind, workspaceRoot, hostRoots, includeTmp } = config;
  const home = (0, import_node_os2.homedir)();
  const hostDirBySource = new Map(
    hostRoots.map((root) => [root.source, root.dir])
  );
  const targets = [];
  const userPiDir = hostDirBySource.get("user-pi");
  if (userPiDir !== void 0) {
    targets.push({ dir: userPiDir, source: "user-pi", enabled: true });
  }
  targets.push({ dir: (0, import_node_path2.join)(home, ".agents", kind), source: "user-agents", enabled: true });
  const npmDir = hostDirBySource.get("npm");
  if (npmDir !== void 0) {
    targets.push({ dir: npmDir, source: "npm", enabled: true });
  }
  const npmDevDir = hostDirBySource.get("npm-dev");
  if (npmDevDir !== void 0) {
    targets.push({ dir: npmDevDir, source: "npm-dev", enabled: true });
  }
  targets.push(
    ...readExtensionPaths().map((dir) => ({ dir, source: "user-extension-paths", enabled: true }))
  );
  targets.push({ dir: (0, import_node_path2.join)(workspaceRoot, ".pi", kind), source: "project-pi", enabled: true });
  if (includeTmp) {
    targets.push({
      dir: (0, import_node_path2.join)(workspaceRoot, ".pi", kind, ".tmp"),
      source: "project-pi-tmp",
      enabled: true
    });
  }
  targets.push({
    dir: (0, import_node_path2.join)(workspaceRoot, ".agents", kind),
    source: "project-agents",
    enabled: true
  });
  return targets.filter((t) => t.enabled);
}
async function discoverResources(config) {
  const targets = buildScanTargets(config);
  const allBySource = await Promise.all(
    targets.map(async (target) => {
      if (target.source === "npm" || target.source === "npm-dev") {
        const resources2 = await scanNpmDir(target.dir, config.kind);
        const tagged = resources2.map((r) => ({ ...r, source: target.source }));
        return { source: target.source, resources: tagged };
      }
      if (target.source === "user-extension-paths") {
        const resources2 = await processPackage(target.dir, config.kind);
        const tagged = resources2.map((r) => ({ ...r, source: target.source }));
        return { source: target.source, resources: tagged };
      }
      const files = await scanDirectory(target.dir, config.kind);
      const resources = files.map((f) => ({ path: f, source: target.source, available: true }));
      return { source: target.source, resources };
    })
  );
  const merged = /* @__PURE__ */ new Map();
  for (const { resources } of allBySource) {
    for (const r of resources) {
      const key = stem(r.path);
      const existing = merged.get(key);
      if (!r.available && existing) {
        continue;
      }
      if (existing && existing.path !== r.path) {
        const msg = `[resource-discovery] duplicate ${config.kind} "${key}" from ${r.source} shadows ${existing.source}`;
        const data = { shadowed: existing.path, kept: r.path };
        if (isMachineSource(existing.source) || isMachineSource(r.source)) {
          logger4.debug(msg, data);
        } else {
          const dedupKey = `${config.kind}|${key}|${existing.path}|${r.path}`;
          if (!shadowWarnDedup.has(dedupKey)) {
            if (shadowWarnDedup.size >= MAX_SHADOW_WARN_DEDUP) {
              shadowWarnDedup.clear();
            }
            shadowWarnDedup.add(dedupKey);
            logger4.warn(msg, data);
          }
        }
      }
      merged.set(key, r);
    }
  }
  return Array.from(merged.values());
}

// src/orchestration/config-loader.ts
var import_node_path4 = require("path");

// src/shared/agent-ref.ts
var import_node_os3 = require("os");
var import_node_path3 = require("path");
var HOME_DIR_PREFIX = "~/";
function normalizeRef(ref, ext) {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const expanded = trimmed.startsWith(HOME_DIR_PREFIX) ? (0, import_node_path3.join)((0, import_node_os3.homedir)(), trimmed.slice(HOME_DIR_PREFIX.length)) : trimmed;
  if (!(0, import_node_path3.isAbsolute)(expanded)) return null;
  if (ext !== void 0 && !expanded.endsWith(ext)) return null;
  return expanded;
}
var WORKFLOW_REF_EXT = ".js";

// src/orchestration/config-loader.ts
var logger5 = getLogger("config-loader");
var cache2 = /* @__PURE__ */ new Map();
function getCacheBucket(workspaceRoot) {
  let bucket = cache2.get(workspaceRoot);
  if (!bucket) {
    bucket = /* @__PURE__ */ new Map();
    cache2.set(workspaceRoot, bucket);
  }
  return bucket;
}
function isCacheValid(entry) {
  const file = getCachedFile(entry.meta.path);
  return file !== null && file.mtimeMs === entry.mtimeMs;
}
function stem2(filePath) {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
function toWorkflowSource(source) {
  return source === "project-pi-tmp" ? "tmp" : "saved";
}
function deriveResourceSource(filePath, workspaceRoot) {
  const tmpDir = (0, import_node_path4.resolve)(workspaceRoot, ".pi/workflows/.tmp");
  const normalized = (0, import_node_path4.resolve)(filePath);
  return normalized === tmpDir || normalized.startsWith(`${tmpDir}/`) ? "project-pi-tmp" : "user-pi";
}
async function toCachedMeta(filePath, source) {
  const fallbackName = stem2(filePath);
  const wfSource = toWorkflowSource(source);
  try {
    const content = getCachedFileContent(filePath);
    if (content === null) throw new Error("file not readable");
    const meta = parseResourceMeta(content, "workflow");
    if (meta && meta.kind === "workflow") {
      return { ...meta, path: filePath, available: true, source: wfSource };
    }
    logger5.warn(
      `[config-loader] ${filePath}: \u672A\u89E3\u6790\u5230 @pi-meta \u5143\u6570\u636E\uFF08\u65E7 const meta \u683C\u5F0F\u9700\u8FC1\u79FB\uFF09\u2192 available=false`
    );
  } catch (err) {
    logger5.debug(`[config-loader] skip unreadable workflow file ${filePath}`, {
      reason: err instanceof Error ? err.message : String(err)
    });
  }
  return {
    kind: "workflow",
    name: fallbackName,
    description: "",
    phases: [],
    path: filePath,
    available: false,
    source: wfSource
  };
}
function toScanConfig(configOrCwd) {
  if (configOrCwd?.projectDir) {
    const workspaceRoot2 = (0, import_node_path4.resolve)(configOrCwd.projectDir, "../..");
    return {
      kind: "workflows",
      workspaceRoot: workspaceRoot2,
      hostRoots: [],
      includeTmp: true
    };
  }
  const cwd = configOrCwd?.cwd;
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    kind: "workflows",
    workspaceRoot,
    hostRoots: getHostServices().discoveryRoots?.()?.workflows ?? [],
    includeTmp: true
  };
}
async function discoverWorkflows(configOrCwd) {
  const scanConfig = toScanConfig(configOrCwd);
  const workspaceRoot = scanConfig.workspaceRoot;
  const resources = await discoverResources(scanConfig);
  const mergedMap = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    const cachedMeta = await toCachedMeta(resource.path, resource.source);
    if (!cachedMeta.available && mergedMap.has(cachedMeta.name)) {
      continue;
    }
    mergedMap.set(cachedMeta.name, cachedMeta);
  }
  const merged = Array.from(mergedMap.values()).sort(
    (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const bucket = getCacheBucket(workspaceRoot);
  for (const wf of merged) {
    const file = getCachedFile(wf.path);
    bucket.set(wf.name, { meta: wf, mtimeMs: file?.mtimeMs ?? 0 });
  }
  return merged;
}
async function loadWorkflows() {
  return discoverWorkflows();
}
async function getWorkflow(name) {
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }
  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}
async function getWorkflowByPath(ref) {
  const filePath = normalizeRef(ref, WORKFLOW_REF_EXT);
  if (filePath === null) return void 0;
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(filePath);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }
  const meta = await toCachedMeta(filePath, deriveResourceSource(filePath, workspaceRoot));
  const file = getCachedFile(filePath);
  if (file) bucket.set(filePath, { meta, mtimeMs: file.mtimeMs });
  return meta;
}
function invalidateCache() {
  clearFileCache();
  cache2.clear();
  clearLintMemo();
}

// src/orchestration/workflow-script-registry-impl.ts
var WorkflowScriptRegistryImpl = class {
  constructor(config) {
    this.config = config;
  }
  config;
  /**
   * 扫描所有 workflow 脚本（project + user + tmp），按 tmp>project>user 优先级
   * 去重，返回 WorkflowScript 实体数组（含 available=false 的解析失败项）。
   *
   * 60s TTL 缓存——同 workspace 60s 内重复调用走缓存。
   */
  async loadAll() {
    const metas = this.config ? await discoverWorkflows(this.config) : await loadWorkflows();
    return metas.map((m) => this.toScript(m));
  }
  /**
   * 按名查单个脚本。精确匹配。
   * 返回 undefined 当 name 不存在。
   *
   * 注：fuzzy 匹配由 Interface 层 tool-workflow负责——registry 只做精确查。
   *
   * 性能注记：无 config（生产路径）时走 getWorkflow 的 60s TTL 单条缓存。
   * 有 config（测试隔离）时退化为每次 discoverWorkflows 全扫——测试场景
   * 可接受，生产路径不受影响。
   */
  async get(name) {
    const meta = this.config ? (await discoverWorkflows(this.config)).find((w) => w.name === name) : await getWorkflow(name);
    return meta ? this.toScript(meta) : void 0;
  }
  /**
   * 按绝对路径加载单个脚本（S2 路径统一）。任意路径（不限扫描源）。
   * 供 workflow tool 的 run/info（name 参数 = workflowRef）。
   */
  async getPath(ref) {
    const meta = await getWorkflowByPath(ref);
    return meta ? this.toScript(meta) : void 0;
  }
  /** 失效缓存——下次 loadAll/get 重新扫描文件系统。 */
  invalidate() {
    invalidateCache();
  }
  /**
  * 把 CachedWorkflowMeta 转换为 WorkflowScript 实体。
  *
  * m2：整对象透传——m 已是 WorkflowMeta（CachedWorkflowMeta extends WorkflowMeta），
  * 直接传 meta: m，不再 {name,description,phases} 重建。消灭第 3 处重映射，
  * parameters/usage/when/notFor 一路流到 script.meta。
  *
  * sourceCode 在此 readFile 填充（FR-2：registry 是唯一读文件处）。
  * available：meta 提取失败或文件不可读时为 false。
  */
  toScript(m) {
    let sourceCode = "";
    let available = m.available;
    if (available) {
      try {
        const cachedContent = getCachedFileContent(m.path);
        if (cachedContent === null) {
          sourceCode = "";
          available = false;
        } else {
          sourceCode = cachedContent;
        }
      } catch {
        sourceCode = "";
        available = false;
      }
    }
    return new WorkflowScript({
      name: m.name,
      source: m.source,
      path: m.path,
      sourceCode,
      // meta: m 整对象透传（m2 决策）：故意不做显式投影——投影会重引入
      // {name,description,phases} 解构重映射反模式（m2 消灭的丢字段 bug）。
      // CachedWorkflowMeta 多带的 path/available/source 是良性泄漏（无消费者
      // 序列化 script.meta）；若未来有消费者，改为组合式 { meta, path, ... } 而非投影。
      meta: m,
      available
    });
  }
};

// src/orchestration/file-run-store.ts
var import_promises2 = require("fs/promises");
var import_node_path5 = require("path");
var logger6 = getLogger("file-run-store");
var STATE_DIR_NAME = "workflow-state";
function toBudgetSnapshot(b) {
  return {
    maxTokens: b.maxTokens,
    maxCost: b.maxCost,
    maxTimeMs: b.maxTimeMs,
    usedTokens: b.usedTokens,
    usedCost: b.usedCost,
    totalCallCount: b.totalCallCount
  };
}
function toSnapshot(run) {
  const { budgetRef: _budgetRef, ...spec } = run.spec;
  return {
    runId: run.runId,
    spec,
    state: {
      status: run.state.status,
      reason: run.state.reason,
      budget: toBudgetSnapshot(run.state.budget),
      calls: Array.from(run.state.calls.values(), (c) => ({
        id: c.id,
        opts: c.opts,
        status: c.status,
        attempts: c.attempts,
        result: c.result,
        sessionId: c.sessionId,
        sessionFile: c.sessionFile,
        traceNode: c.traceNode
      })),
      trace: [...run.state.trace.toArray()],
      errorLogs: run.state.errorLogs,
      error: run.state.error,
      scriptResult: run.state.scriptResult
    },
    meta: run.meta
  };
}
function fromSnapshot(snap) {
  if (snap === null || typeof snap !== "object") return void 0;
  const s = snap;
  if (typeof s.runId !== "string" || !s.runId) return void 0;
  if (!s.spec || typeof s.spec !== "object") return void 0;
  const st = s.state;
  if (!st || typeof st !== "object") return void 0;
  if (st.status !== "running" && st.status !== "done") return void 0;
  if (!st.budget || typeof st.budget !== "object") return void 0;
  if (!Array.isArray(st.calls) || !Array.isArray(st.trace)) return void 0;
  if (!s.meta || typeof s.meta !== "object") return void 0;
  const trace = Trace.fromArray(st.trace);
  const calls = /* @__PURE__ */ new Map();
  for (const c of st.calls) {
    if (c === null || typeof c !== "object" || typeof c.id !== "number") continue;
    const linked = trace.toArray().find((n) => n.stepIndex === c.traceNode?.stepIndex) ?? (c.traceNode ? { ...c.traceNode } : void 0);
    if (!linked) continue;
    const call = new AgentCall(c.id, c.opts, linked);
    call.status = c.status;
    call.attempts = c.attempts;
    if (c.result !== void 0) call.result = c.result;
    if (c.sessionId !== void 0) call.sessionId = c.sessionId;
    if (c.sessionFile !== void 0) call.sessionFile = c.sessionFile;
    calls.set(c.id, call);
  }
  return WorkflowRun.reconstruct(
    s.runId,
    s.spec,
    {
      status: st.status,
      reason: st.reason,
      budget: new Budget(st.budget),
      calls,
      trace,
      errorLogs: Array.isArray(st.errorLogs) ? st.errorLogs : [],
      error: st.error,
      scriptResult: st.scriptResult
    },
    s.meta
  );
}
var FileRunStore = class {
  /** run 状态目录绝对路径（dataRoot 每次现取——宿主覆盖配置即刻生效，对齐
   *  data-dir.ts「不缓存路径防测试/宿主切换读到旧值」先例）。 */
  stateDir() {
    return (0, import_node_path5.join)(getHostServices().dataRoot(), STATE_DIR_NAME);
  }
  stateFilePath(runId) {
    return (0, import_node_path5.join)(this.stateDir(), `${runId}.jsonl`);
  }
  async save(run) {
    await (0, import_promises2.mkdir)(this.stateDir(), { recursive: true });
    const line = JSON.stringify(toSnapshot(run));
    await (0, import_promises2.appendFile)(this.stateFilePath(run.runId), line + "\n", "utf8");
  }
  async loadAll() {
    let files;
    try {
      files = await (0, import_promises2.readdir)(this.stateDir());
    } catch {
      return [];
    }
    const runs = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const run = await this.loadLatestValidLine((0, import_node_path5.join)(this.stateDir(), file), file);
      if (run) runs.push(run);
    }
    return runs;
  }
  /** 单文件从尾向头取第一条有效快照行；整文件无有效行返回 undefined（warn）。 */
  async loadLatestValidLine(absPath, display) {
    let content;
    try {
      content = await (0, import_promises2.readFile)(absPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger6.warn(`[file-run-store] skip unreadable state file ${display}: ${msg}`);
      return void 0;
    }
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue;
      const run = this.parseLine(line, display, i);
      if (run) return run;
    }
    logger6.warn(`[file-run-store] no valid snapshot line in ${display} (empty or all corrupted)`);
    return void 0;
  }
  /** 单行解析 + 形状校验；损坏 warn 并返回 undefined。 */
  parseLine(line, display, lineNo) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger6.warn(`[file-run-store] skip corrupted line ${display}:${lineNo}: ${msg}`);
      return void 0;
    }
    const run = fromSnapshot(parsed);
    if (run === void 0) {
      logger6.warn(`[file-run-store] skip malformed snapshot ${display}:${lineNo} (shape validation failed)`);
      return void 0;
    }
    return run;
  }
};

// src/execution/engine/common/data-dir.ts
var logger7 = getLogger("subagents");
var XYZ_DATA_DIR_ENV = "XYZ_AGENT_DATA_DIR";
var warned = false;
function getEngineDataDir(env = process.env, warn = defaultWarn) {
  const fromEnv = env[XYZ_DATA_DIR_ENV]?.trim();
  if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
  const fallback = getHostServices().dataRoot();
  if (!warned) {
    warned = true;
    warn(
      `[engine-data-dir] ${XYZ_DATA_DIR_ENV} is not set; engine journal/pool fall back to the pi agent dir (${fallback}). The xyz-agent host normally injects this env \u2014 if you are running inside xyz-agent, check the runtime spawn env; standalone pi installs intentionally use the pi agent dir.`
    );
  }
  return fallback;
}
function defaultWarn(msg) {
  logger7.warn(msg);
}

// src/execution/engine/engines/zcode/constants.ts
var ZCODE_ENGINE_ID = "zcode";
var ZCODE_ADAPTER_VERSION = "1.0.0";
var ZCODE_CLI_DEFAULT_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
var ZCODE_V2_CONFIG_PATH_SUFFIX = [".zcode", "v2", "config.json"];
var ZCODE_POOL_CONFIG_SUFFIX = [".zcode", "cli", "config.json"];
var ZCODE_POOL_DB_RELATIVE_PATH = ".zcode/cli/db/db.sqlite";
var ZCODE_FALLBACK_DEFAULT_MODEL = "builtin:bigmodel-coding-plan/GLM-5.3";
var ZCODE_KILL_GRACE_MS = 5e3;
var ZCODE_ERROR_TAIL_CHARS = 2e3;

// src/execution/engine/engines/zcode/zcode-engine.ts
var import_node_child_process2 = require("child_process");
var fs4 = __toESM(require("fs"), 1);
var path3 = __toESM(require("path"), 1);

// src/execution/engine/common/schema-emulation.ts
var import_ajv2 = __toESM(require_ajv(), 1);
var SCHEMA_EMULATION_TAIL_CHARS = 500;
function buildSchemaEmulationSegment(schema) {
  const schemaJson = JSON.stringify(schema);
  return [
    "## Structured Output Requirement",
    "Your final answer MUST contain exactly one JSON value conforming to this JSON Schema (draft-07):",
    schemaJson,
    "Output rules:",
    "- Output ONLY the JSON value \u2014 no prose before or after it.",
    "- If you wrap it in a markdown code fence, use a single ```json fence.",
    "- Do not output multiple JSON values; the first complete JSON value is extracted."
  ].join("\n");
}
function extractAndValidateStructuredOutput(text, schema) {
  return extractImpl(text, schema);
}
function extractImpl(text, schema) {
  const tail = text.length > SCHEMA_EMULATION_TAIL_CHARS ? text.slice(text.length - SCHEMA_EMULATION_TAIL_CHARS) : text;
  const extracted = extractJsonCandidate(text);
  if (extracted === void 0) {
    return {
      ok: false,
      error: "could not extract JSON from model output after 3-stage fallback (direct parse -> code-fence strip -> bracket scan)",
      tail
    };
  }
  const validate = getOrCompileValidator(schema);
  if (validate === void 0) {
    return {
      ok: false,
      error: "host-side JSON Schema compilation failed (invalid schema object)",
      tail
    };
  }
  const valid = validate(extracted);
  if (!valid) {
    const errors = validate.errors?.map((err) => `${err.instancePath} ${err.message}`).join("; ");
    return {
      ok: false,
      error: `Schema validation failed: ${errors ?? "(no detail)"}`,
      tail
    };
  }
  return { ok: true, parsed: extracted };
}
function extractJsonCandidate(text) {
  const direct = tryParse(text.trim());
  if (direct.ok) return direct.value;
  const fenced = extractFirstFencedBlock(text);
  if (fenced !== void 0) {
    const parsed = tryParse(fenced.trim());
    if (parsed.ok) return parsed.value;
  }
  const scanned = extractByBracketScan(text);
  if (scanned !== void 0) {
    const parsed = tryParse(scanned.trim());
    if (parsed.ok) return parsed.value;
  }
  return void 0;
}
function tryParse(raw) {
  if (raw === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
function extractFirstFencedBlock(text) {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return match?.[1];
}
function extractByBracketScan(text) {
  const objOpen = text.indexOf("{");
  const arrOpen = text.indexOf("[");
  const open2 = objOpen === -1 ? arrOpen : arrOpen === -1 ? objOpen : Math.min(objOpen, arrOpen);
  const objClose = text.lastIndexOf("}");
  const arrClose = text.lastIndexOf("]");
  const close = Math.max(objClose, arrClose);
  if (open2 === -1 || close === -1 || open2 >= close) return void 0;
  return text.slice(open2, close + 1);
}
var ajvCache = /* @__PURE__ */ new WeakMap();
function getOrCompileValidator(schema) {
  const cached = ajvCache.get(schema);
  if (cached) return cached;
  try {
    const validate = new import_ajv2.default({ strict: false }).compile(schema);
    ajvCache.set(schema, validate);
    return validate;
  } catch {
    return void 0;
  }
}

// src/execution/engine/common/event-journal.ts
var import_promises3 = require("fs/promises");
var import_node_fs = require("fs");
var import_node_path6 = require("path");
var logger8 = getLogger("subagents");
var FLUSH_THRESHOLD_BYTES = 32 * 1024;
function replayJournal(path8) {
  let raw;
  try {
    raw = (0, import_node_fs.readFileSync)(path8, "utf8");
  } catch {
    return [];
  }
  const lines = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    const parsed = parseLine(trimmed);
    if (parsed !== void 0) lines.push(parsed);
  }
  lines.sort((a, b) => a.seq - b.seq);
  return lines.map((l) => l.event);
}
function parseLine(trimmed) {
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const rec = parsed;
  const event = rec.event;
  if (rec.v !== 1 || typeof rec.ts !== "number" || typeof rec.seq !== "number") return void 0;
  if (typeof event !== "object" || event === null || typeof event.type !== "string") {
    return void 0;
  }
  return {
    v: 1,
    ts: rec.ts,
    taskId: typeof rec.taskId === "string" ? rec.taskId : "",
    engineId: typeof rec.engineId === "string" ? rec.engineId : "",
    seq: rec.seq,
    event
  };
}

// src/execution/engine/common/session-view-projection.ts
function toExportedToolCall(tc) {
  return {
    toolName: tc.toolName,
    ...tc.args !== void 0 ? { args: tc.args } : {},
    ...tc.result !== void 0 ? { result: tc.result } : {},
    ...tc.isError !== void 0 ? { isError: tc.isError } : {}
  };
}
function toReplayedTurn(turn) {
  return {
    text: turn.text,
    thinking: turn.thinking,
    toolCalls: turn.toolCalls.map(toExportedToolCall),
    closed: true
  };
}
function aggregateUsage(turns) {
  let acc;
  for (const turn of turns) {
    const d = turn.usageDelta;
    if (!d) continue;
    if (!acc) acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 };
    acc.input += d.input;
    acc.output += d.output;
    acc.cacheRead += d.cacheRead;
    acc.cacheWrite += d.cacheWrite;
    acc.cost += d.cost ?? 0;
  }
  if (acc) acc.total = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  return acc;
}

// src/execution/engine/common/journal-replay.ts
function replayJournalToSessionView(handle, engineId) {
  const journalPath = handle.data.journalPath;
  if (journalPath === void 0) return void 0;
  const events = replayJournal(journalPath);
  if (events.length === 0) return void 0;
  return eventsToSessionView(events, engineId, sessionIdFromHandle(handle));
}
function eventsToSessionView(events, engineId, sessionId) {
  const record = createRecord("journal-replay", {
    agent: "journal-replay",
    model: "",
    mode: "background",
    task: "",
    slug: "",
    startedAt: 0
  });
  for (const ev of events) updateFromEvent(record, ev);
  return {
    engineId,
    ...sessionId !== void 0 ? { sessionId } : {},
    turns: record.turns.map(toReplayedTurn),
    usage: aggregateUsage(record.turns),
    source: "journal"
  };
}
function sessionIdFromHandle(handle) {
  const v = handle.data.sessionRef["sessionId"];
  return typeof v === "string" ? v : void 0;
}

// src/execution/engine/paths.ts
var import_node_path7 = require("path");
var MAX_SEG_CHARS = 80;
function sanitizeSeg(input) {
  const s = input.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s.slice(0, MAX_SEG_CHARS) : "default";
}
function resolveEnginesRoot(dataDir) {
  return (0, import_node_path7.join)(dataDir, "engines");
}
function resolveEngineDir(dataDir, engineId) {
  return (0, import_node_path7.join)(resolveEnginesRoot(dataDir), sanitizeSeg(engineId));
}
function resolvePoolDir(dataDir, engineId, poolKey) {
  return (0, import_node_path7.join)(resolveEngineDir(dataDir, sanitizeSeg(engineId)), sanitizeSeg(poolKey));
}

// src/execution/engine/engines/zcode/golden-sample.ts
var ZCODE_GOLDEN_STDOUT = `{
  "sessionId": "sess_35852a0f-1302-4e20-9e48-87f47527abe3",
  "traceId": "9fffaebd-749e-468b-af3f-2a89e3347785",
  "turnId": "turn_99879260-1c9b-4e97-afe1-c2e7abeaf5b9",
  "response": "ok",
  "usage": {
    "source": "provider",
    "modelRequestCount": 1,
    "inputTokens": 12599,
    "outputTokens": 17,
    "totalTokens": 12616,
    "cacheReadTokens": 512,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0,
    "webFetchRequests": 0,
    "webSearchRequests": 0
  },
  "eventCount": 17,
  "projection": {
    "status": "idle",
    "turnCount": 1,
    "totalTokenCount": 12616,
    "contextUsed": 12616,
    "contextWindow": 1000000
  }
}
`;

// src/execution/engine/engines/zcode/launcher.ts
var import_node_child_process = require("child_process");
var import_node_stream = require("stream");

// src/execution/engine/common/nesting-guard.ts
var NESTED_SPAWN_ENV = "XYZ_AGENT_SUBAGENT";
var NATIVE_NESTED_KEYS = ["CLAUDECODE", "ZSW_NESTED"];
var NATIVE_NESTED_PREFIXES = ["PI_SUBAGENT_"];
function buildNestedSpawnEnv(baseEnv) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (NATIVE_NESTED_KEYS.includes(key)) continue;
    if (NATIVE_NESTED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env[NESTED_SPAWN_ENV] = "1";
  return env;
}

// src/execution/engine/common/persona-router.ts
var DEFAULT_ARGV_BUDGET_BYTES = (
  // eslint-disable-next-line no-magic-numbers -- 128KB = 128 * 1024 bytes 预算换算常数
  128 * 1024
);
function estimateArgvBytes(argv) {
  let total = 0;
  for (const arg of argv) {
    total += Buffer.byteLength(arg, "utf8") + 1;
  }
  return total;
}
function assertArgvBudget(argv, limitBytes = DEFAULT_ARGV_BUDGET_BYTES) {
  const actual = estimateArgvBytes(argv);
  if (actual > limitBytes) {
    throw promptTooLargeError(actual, limitBytes);
  }
}

// src/execution/engine/engines/zcode/launcher.ts
function buildZcodeArgv(spec) {
  const args = ["--json", "--cwd", spec.cwd, "--mode", "yolo"];
  const disallowed = (spec.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
  if (disallowed.length > 0) args.push("--disallowed-tools", disallowed.join(","));
  if (spec.resumeSessionId) args.push("--resume", String(spec.resumeSessionId));
  args.push("--prompt", String(spec.prompt));
  return args;
}
function assertZcodeArgvBudget(nodeBin, cliPath, args) {
  assertArgvBudget([nodeBin, cliPath, ...args]);
}
function buildZcodeEnv(homeDir, baseEnv = process.env) {
  return { ...buildNestedSpawnEnv(baseEnv), HOME: homeDir };
}
function launchZcodeProcess(opts) {
  const nodeBin = opts.nodeBin ?? "node";
  const child = (0, import_node_child_process.spawn)(nodeBin, [opts.cliPath, ...opts.args], {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let exited = false;
  let killTriggered = false;
  const emptyStream = () => import_node_stream.Readable.from([]);
  const stdoutStream = child.stdout ?? emptyStream();
  const stderrStream = child.stderr ?? emptyStream();
  const exitedPromise = new Promise((resolve4) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolve4({ code, signal: signal ?? void 0 });
    });
    child.once("error", () => {
      exited = true;
      resolve4({ code: null, signal: void 0 });
    });
  });
  const abort = (graceMs = ZCODE_KILL_GRACE_MS) => {
    if (!killTriggered && !exited) {
      killTriggered = true;
      void killChain(child, { graceMs });
    }
    return exitedPromise.then(() => void 0);
  };
  return {
    child,
    pid: child.pid ?? -1,
    stdout: stdoutStream,
    stderr: stderrStream,
    abort,
    exited: exitedPromise,
    killedByUs: () => killTriggered
  };
}

// src/execution/engine/engines/zcode/parser.ts
var DEFAULT_HEAD_BYTES = 4096;
var DEFAULT_TAIL_BYTES = 64 * 1024;
function createBoundedLineBuffer(opts = {}) {
  const headLimit = opts.headLimit ?? DEFAULT_HEAD_BYTES;
  const tailLimit = opts.tailLimit ?? DEFAULT_TAIL_BYTES;
  let pending = "";
  let head = "";
  let headFull = false;
  const tailLines = [];
  let tailBytes = 0;
  let droppedBytes = 0;
  function addLine(line) {
    if (!headFull) {
      if (head.length + line.length <= headLimit) {
        head += line;
        return;
      }
      headFull = true;
    }
    tailLines.push(line);
    tailBytes += line.length;
    while (tailBytes > tailLimit && tailLines.length > 1) {
      const dropped = tailLines.shift();
      tailBytes -= dropped.length;
      droppedBytes += dropped.length;
    }
    if (tailBytes > tailLimit && tailLines.length === 1) {
      const over = tailBytes - tailLimit;
      tailLines[0] = tailLines[0].slice(over);
      tailBytes -= over;
      droppedBytes += over;
    }
  }
  return {
    push(chunk) {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        addLine(pending.slice(0, nl + 1));
        pending = pending.slice(nl + 1);
      }
    },
    flush() {
      if (pending !== "") {
        addLine(pending);
        pending = "";
      }
    },
    text() {
      this.flush();
      const mid = droppedBytes > 0 ? `
[zcode-engine] \u8F93\u51FA\u8FC7\u957F\uFF0C\u5934\u5C3E\u4E4B\u95F4\u5DF2\u4E22\u5F03 ${droppedBytes} \u5B57\u8282
` : "";
      return head + mid + tailLines.join("");
    },
    tail(n) {
      const t = this.text();
      return t.length > n ? t.slice(t.length - n) : t;
    }
  };
}
function parseZcodeStdoutJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    void err;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}
function finiteOr(v, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function mapZcodeUsage(raw) {
  if (typeof raw !== "object" || raw === null) return void 0;
  const r = raw;
  if (r.inputTokens === void 0 && r.outputTokens === void 0) return void 0;
  return {
    input: finiteOr(r.inputTokens, 0),
    output: finiteOr(r.outputTokens, 0),
    cacheRead: finiteOr(r.cacheReadTokens, 0),
    cacheWrite: finiteOr(r.cacheWriteTokens, 0)
  };
}
function mapZcodeOutcomeUsage(rawUsage, projection) {
  const base = mapZcodeUsage(rawUsage);
  if (base === void 0) return void 0;
  const p = typeof projection === "object" && projection !== null ? projection : {};
  const r = typeof rawUsage === "object" && rawUsage !== null ? rawUsage : {};
  const contextTokens = firstFinite(p["contextUsed"], r.totalTokens, 0);
  const turns = firstFinite(p["turnCount"], 1);
  return { ...base, cost: 0, contextTokens, turns };
}
function firstFinite(...vals) {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
function parseZcodeTerminal(stdout) {
  const parsed = parseZcodeStdoutJson(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "stdout \u4E0D\u662F JSON \u5BF9\u8C61" };
  }
  const obj = parsed;
  if (typeof obj.response !== "string") {
    return { ok: false, reason: "\u7EC8 JSON \u7F3A string \u578B response \u5B57\u6BB5\uFF08zcode \u683C\u5F0F\u6F02\u79FB\u5ACC\u7591\uFF09" };
  }
  const usage = mapZcodeUsage(obj.usage);
  const projection = typeof obj.projection === "object" && obj.projection !== null ? obj.projection : void 0;
  const outcomeUsage = mapZcodeOutcomeUsage(obj.usage, projection);
  const turnCountRaw = projection?.turnCount;
  return {
    ok: true,
    payload: {
      response: obj.response,
      ...typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {},
      ...usage !== void 0 ? { usage } : {},
      ...outcomeUsage !== void 0 ? { outcomeUsage } : {},
      ...typeof turnCountRaw === "number" && Number.isFinite(turnCountRaw) ? { turnCount: turnCountRaw } : {}
    }
  };
}
var DRAIN_TIMEOUT_MS = 1e3;
function drainReadable(stream) {
  return new Promise((resolve4) => {
    if (stream.readableEnded || stream.destroyed) {
      resolve4();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.removeListener("end", finish);
      stream.removeListener("close", finish);
      stream.removeListener("error", finish);
      clearTimeout(timer);
      resolve4();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
  });
}
async function collectZcodeOutput(proc) {
  const outBuf = createBoundedLineBuffer();
  const errBuf = createBoundedLineBuffer({ headLimit: 0, tailLimit: DEFAULT_TAIL_BYTES });
  proc.stdout.on("data", (d) => {
    outBuf.push(typeof d === "string" ? d : d.toString("utf8"));
  });
  proc.stderr.on("data", (d) => {
    errBuf.push(typeof d === "string" ? d : d.toString("utf8"));
  });
  const { code, signal } = await proc.exited;
  await drainReadable(proc.stdout);
  await drainReadable(proc.stderr);
  outBuf.flush();
  errBuf.flush();
  return {
    exitCode: code,
    ...signal !== void 0 ? { signal } : {},
    stdoutText: outBuf.text(),
    stderrTail: errBuf.text()
  };
}
function synthesizeCoarseEvents(response, usage) {
  return [
    // usage 给不出完整形状时显式缺省整个字段，不给残缺对象（不变量 2）
    { type: "message_end", ...usage !== void 0 ? { usage } : {} },
    { type: "turn_end" }
  ];
}
var STDERR_TAIL_IN_MSG_CHARS = 500;
var LLM_API_FAILURE_SIGNATURE = "APICallError";
function isLlmTurnFailure(stderrTail) {
  if (stderrTail === void 0) return false;
  return stderrTail.includes(LLM_API_FAILURE_SIGNATURE) || stderrTail.includes("Turn execution failed");
}
function extractHttpStatus(stderrTail) {
  if (stderrTail === void 0) return "";
  const m = stderrTail.match(/statusCode:\s*(\d{3})/);
  if (m === null) return "";
  const code = m[1];
  const meaning = {
    "401": "\u2014\u2014\u51ED\u636E\u65E0\u6548\u6216\u8FC7\u671F\uFF08apiKey \u88AB\u4E0A\u6E38\u62D2\u7EDD\uFF09",
    "403": "\u2014\u2014\u51ED\u636E\u65E0\u6743\u9650\uFF08apiKey \u6709\u6548\u4F46\u65E0\u8BE5\u6A21\u578B/\u8D44\u6E90\u6743\u9650\uFF09",
    "404": "\u2014\u2014\u6A21\u578B\u6216\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF08\u6838\u5BF9\u6A21\u578B\u540D\u4E0E baseURL\uFF09",
    "429": "\u2014\u2014\u9650\u6D41/\u914D\u989D\u8017\u5C3D"
  };
  return `\uFF0CHTTP ${code}${meaning[code] ?? ""}`;
}
function compactStderrObjectNoise(tail) {
  const OBJECT_LINE = /^(\[Object\][,\s]*)+$/;
  const lines = tail.split("\n");
  const out = [];
  let run = 0;
  const flush = () => {
    if (run > 0) {
      out.push(`[Object]\xD7${run}`);
      run = 0;
    }
  };
  for (const line of lines) {
    if (OBJECT_LINE.test(line.trim())) {
      run++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}
function buildRunFailedMessage(opts) {
  const parts = [];
  if (opts.parseReason !== void 0) {
    parts.push(`\u89E3\u6790\u5931\u8D25\uFF1A${opts.parseReason}\u3002`);
  }
  parts.push(`exit code: ${opts.exitCode ?? "null\uFF08\u88AB\u4FE1\u53F7\u6740\u6B7B\uFF09"}\u3002`);
  if (opts.stderrTail !== void 0 && opts.stderrTail.trim() !== "") {
    const compacted = compactStderrObjectNoise(opts.stderrTail);
    parts.push(`stderr \u5C3E\u90E8: ${compacted.slice(-STDERR_TAIL_IN_MSG_CHARS)}`);
  }
  if (opts.stdoutTail.trim() !== "") {
    parts.push(`stdout \u5C3E\u90E8: ${opts.stdoutTail.slice(-ZCODE_ERROR_TAIL_CHARS)}`);
  }
  if (isLlmTurnFailure(opts.stderrTail)) {
    const statusHint = extractHttpStatus(opts.stderrTail);
    const modelHint = opts.modelRef !== void 0 ? `\uFF08\u672C\u4EFB\u52A1\u6A21\u578B '${opts.modelRef}'\uFF09` : "";
    const configHint = opts.configPath !== void 0 ? `\u2460 \u6838\u5BF9\u6C60\u5185 provider \u7684 baseURL \u53EF\u8FBE\u6027\u4E0E apiKey \u6709\u6548\u6027\uFF08\`${opts.configPath}\`\uFF09${statusHint.includes("401") || statusHint.includes("403") ? "\u2014\u2014apiKey \u5927\u6982\u7387\u65E0\u6548\u6216\u8FC7\u671F\uFF0C\u9700\u5728\u51ED\u636E\u6765\u6E90\uFF08ZCode \u684C\u9762\u6216\u81EA\u5EFA\u7F51\u5173\uFF09\u66F4\u65B0" : ""}\uFF1B` : `\u2460 \u6838\u5BF9 zcode \u6C60\u5185 provider \u7684 baseURL \u53EF\u8FBE\u6027\u4E0E apiKey \u6709\u6548\u6027${statusHint}\uFF1B`;
    parts.push(
      `\u6062\u590D\u6307\u5F15\uFF1A\u6A21\u578B API \u8C03\u7528\u5931\u8D25${statusHint}\u2014\u2014CLI \u672C\u4F53\u4E0E\u8F93\u51FA\u89E3\u6790\u6B63\u5E38\uFF0C\u95EE\u9898\u5728\u6A21\u578B\u7AEF\u70B9\u6216\u51ED\u636E${modelHint}\u3002` + configHint + "\u2461 \u4FEE\u590D\u540E\u76F4\u63A5\u91CD\u8DD1\u672C\u4EFB\u52A1\uFF08probe \u7F13\u5B58\u4E0D\u53D7\u5F71\u54CD\u2014\u2014\u8FD0\u884C\u671F\u5931\u8D25\u4E0D\u7F13\u5B58\uFF09\uFF1B\u2462 \u6216\u4EFB\u52A1\u663E\u5F0F\u6307\u5B9A\u5176\u4ED6\u53EF\u7528\u6A21\u578B\uFF08provider/model \u5168\u540D\uFF09\uFF1B\u2463 \u6216\u6539\u7528 engine: pi \u91CD\u8DD1\u672C\u4EFB\u52A1\u3002"
    );
  } else {
    parts.push(
      `\u6062\u590D\u6307\u5F15\uFF1A\u8DD1 \`node ${opts.cliPath} --version\` \u786E\u8BA4\u7248\u672C\u540E\u91CD\u8DD1\u63A2\u9488\uFF08probe\uFF09\u2014\u2014\u82E5\u4E3A\u683C\u5F0F\u6F02\u79FB\uFF0C\u628A\u65B0 stdout \u6837\u672C\u8865\u5F55\u8FDB golden \u5E93\uFF08\`__tests__/__fixtures__/zcode-golden-spawn.json\`\uFF09\u5E76\u66F4\u65B0 parser\uFF1B\u6216\u6539\u7528 engine: pi \u91CD\u8DD1\u672C\u4EFB\u52A1\u3002\u8BE6\u89C1 docs/research/agent-engine-zcode.md\u3002`
    );
  }
  return `engine_run_failed: zcode CLI \u8FD0\u884C\u5931\u8D25\u3002${parts.join(" ")}`;
}

// src/execution/engine/engines/zcode/preparer.ts
var fs2 = __toESM(require("fs"), 1);
var os = __toESM(require("os"), 1);
var path2 = __toESM(require("path"), 1);
var ZcodePrepareError = class extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "ZcodePrepareError";
    this.code = code;
  }
};
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isProviderEntry(v) {
  return isRecord(v);
}
function readSourceConfig(absPath) {
  const empty = { providers: /* @__PURE__ */ new Map(), mtimeMs: 0 };
  let raw;
  try {
    raw = fs2.readFileSync(absPath, "utf8");
  } catch {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const conf = { providers: /* @__PURE__ */ new Map(), mtimeMs: 0 };
  const provider = parsed["provider"];
  if (isRecord(provider)) {
    for (const [id, entry] of Object.entries(provider)) {
      if (isProviderEntry(entry)) conf.providers.set(id, entry);
    }
  }
  try {
    conf.mtimeMs = fs2.statSync(absPath).mtimeMs;
  } catch {
    conf.mtimeMs = 0;
  }
  return conf;
}
function modelShort(ref) {
  return ref.slice(ref.lastIndexOf("/") + 1);
}
function providerOf(ref) {
  return ref.slice(0, ref.lastIndexOf("/"));
}
function hasApiKey(entry) {
  const key = entry.options?.apiKey;
  return typeof key === "string" && key !== "";
}
function defaultV2ConfigPath() {
  return path2.join(os.homedir(), ...ZCODE_V2_CONFIG_PATH_SUFFIX);
}
var DEFAULT_PROVIDER_ID = "builtin:bigmodel-coding-plan";
function defaultProviderForShortName(merged, withKey) {
  if (merged.has(DEFAULT_PROVIDER_ID)) return DEFAULT_PROVIDER_ID;
  return withKey[0][0];
}
function resolveZcodeModelRef(requested, sources) {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const merged = v2.providers;
  const withKey = [...merged.entries()].filter(([, e]) => hasApiKey(e));
  const wanted = requested?.trim() || void 0;
  const target = wanted ?? ZCODE_FALLBACK_DEFAULT_MODEL;
  if (withKey.length === 0) {
    const hint = wanted ? `model="${wanted}" \u4E0D\u80FD\u6821\u9A8C` : `\u9ED8\u8BA4\u6A21\u578B "${target}" \u4E0D\u80FD\u6821\u9A8C`;
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode \u5F15\u64CE\u627E\u4E0D\u5230\u4EFB\u4F55\u5E26 apiKey \u7684 provider\uFF08${hint}\uFF09\u3002\u5DF2\u8BFB\u6E90\uFF1A${sources?.v2ConfigPath ?? defaultV2ConfigPath()}\u3002\u6062\u590D\u6307\u5F15\uFF1A\u5148\u5728 ZCode \u684C\u9762\u7AEF\u767B\u5F55\u5E76\u914D\u7F6E provider\uFF08v2 config \u5185\u5B58\u5728\u542B apiKey \u7684\u6761\u76EE\uFF09\u540E\u91CD\u8BD5\uFF1B\u51ED\u636E\u914D\u7F6E\u8BF4\u660E\u89C1 docs/research/agent-engine-zcode.md\u3002`
    );
  }
  const provider = target.includes("/") ? providerOf(target) : defaultProviderForShortName(merged, withKey);
  const short = modelShort(target);
  const entry = merged.get(provider);
  if (!entry) {
    const known = withKey.map(([id]) => id).join(", ");
    throw new ZcodePrepareError(
      "model_not_available",
      `\u672A\u77E5 provider "${provider}"\uFF08\u5E26\u51ED\u636E\u7684 provider: ${known}\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u6539\u7528\u4E0A\u8FF0 provider \u4E4B\u4E00\uFF08\u5168\u540D provider/model\uFF09\uFF0C\u6216\u5148\u5728 ZCode \u684C\u9762\u7AEF\u914D\u7F6E\u8BE5 provider \u540E\u91CD\u8BD5\u3002`
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" \u5B58\u5728\u4F46\u672A\u914D\u7F6E apiKey\u3002\u6062\u590D\u6307\u5F15\uFF1A\u5728 ZCode \u684C\u9762\u7AEF\u4E3A\u8BE5 provider \u767B\u5F55\u914D\u7F6E\u51ED\u636E\uFF0C\u6216\u6539\u7528\u5DF2\u914D\u51ED\u636E\u7684 provider\uFF08${withKey.map(([id]) => id).join(", ")}\uFF09\u540E\u91CD\u8BD5\u3002`
    );
  }
  const models = Object.keys(entry.models ?? {});
  if (models.length > 0 && !models.includes(short)) {
    throw new ZcodePrepareError(
      "model_not_available",
      `\u672A\u77E5\u6A21\u578B "${short}"\uFF08provider ${provider} \u4E0B\u53EF\u7528: ${models.join(", ")}\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u6539\u7528\u8BE5 provider \u4E0B\u7684\u6A21\u578B\uFF0C\u6216\u5148\u5728 ZCode \u684C\u9762\u7AEF\u542F\u7528\u76EE\u6807\u6A21\u578B\u540E\u91CD\u8BD5\u3002`
    );
  }
  return `${provider}/${short}`;
}
function listZcodeModels(sources) {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const out = [];
  for (const [pid, entry] of v2.providers) {
    if (!hasApiKey(entry)) continue;
    const providerName = typeof entry["name"] === "string" && entry["name"].trim() !== "" ? entry["name"].trim() : void 0;
    const models = Object.keys(entry.models ?? {});
    for (const model of models) {
      out.push({
        id: `${pid}/${model}`,
        ...providerName !== void 0 ? { name: `${providerName} \xB7 ${model}` } : {}
      });
    }
  }
  return out;
}
function sanitizeProviderDirName(p) {
  return p.replace(/[^A-Za-z0-9._-]/g, "-");
}
function computeZcodePoolKey(modelRef) {
  const provider = providerOf(modelRef);
  const short = modelShort(modelRef).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `home-${sanitizeProviderDirName(provider)}-${short.length > 0 ? short : "default"}`;
}
function homeNeedsBootstrap(configPath, sourceMtimeMs) {
  if (!fs2.existsSync(configPath)) return true;
  let poolMtimeMs = 0;
  try {
    JSON.parse(fs2.readFileSync(configPath, "utf8"));
    poolMtimeMs = fs2.statSync(configPath).mtimeMs;
  } catch {
    return true;
  }
  return sourceMtimeMs > poolMtimeMs;
}
var CONFIG_INDENT_SPACES = 2;
function prepareZcodeHome(opts) {
  const { engineDataDir, modelRef } = opts;
  const poolKey = computeZcodePoolKey(modelRef);
  const homeDir = resolvePoolDir(engineDataDir, "zcode", poolKey);
  const configPath = path2.join(homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
  const v2Path = opts.sources?.v2ConfigPath ?? defaultV2ConfigPath();
  const v2 = readSourceConfig(v2Path);
  const provider = providerOf(modelRef);
  const entry = v2.providers.get(provider);
  if (entry === void 0) {
    throw new ZcodePrepareError(
      "model_not_available",
      `\u672A\u77E5 provider "${provider}"\uFF08v2 config \u65E0\u8BE5\u6761\u76EE\uFF1A${v2Path}\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u5148\u7ECF resolveZcodeModelRef \u6821\u9A8C\u6A21\u578B\u5F15\u7528\uFF0C\u6216\u5148\u5728 ZCode \u684C\u9762\u7AEF\u914D\u7F6E\u8BE5 provider \u540E\u91CD\u8BD5\u3002`
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" \u5B58\u5728\u4F46\u672A\u914D\u7F6E apiKey\uFF08${v2Path} \u91CD\u8BFB\u65E0\u51ED\u636E\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u786E\u8BA4 ZCode \u684C\u9762\u7AEF\u767B\u5F55\u6001\u6709\u6548\u540E\u91CD\u8BD5\uFF1B\u51ED\u636E\u914D\u7F6E\u8BF4\u660E\u89C1 docs/research/agent-engine-zcode.md\u3002`
    );
  }
  const hitSourceMtime = v2.mtimeMs;
  let wroteConfig = false;
  if (homeNeedsBootstrap(configPath, hitSourceMtime)) {
    fs2.mkdirSync(path2.dirname(configPath), { recursive: true });
    const payload = JSON.stringify({ model: { main: modelRef }, provider: { [provider]: entry } }, null, CONFIG_INDENT_SPACES);
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs2.writeFileSync(tmp, payload, "utf8");
      fs2.renameSync(tmp, configPath);
    } finally {
      try {
        if (fs2.existsSync(tmp)) fs2.unlinkSync(tmp);
      } catch (err) {
        void err;
      }
    }
    wroteConfig = true;
  }
  return { modelRef, poolKey, homeDir, configPath, wroteConfig };
}

// src/execution/engine/engines/zcode/reader.ts
var fs3 = __toESM(require("fs"), 1);
var ZcodeReaderError = class extends Error {
  code;
  /** 原始失败细节（缺文件/表漂移/运行时不支持）。 */
  detail;
  constructor(detail, hint) {
    super(
      `[engine_session_read_failed] zcode \u539F\u751F session \u8BFB\u53D6\u5931\u8D25\uFF1A${detail}\u3002` + (hint ?? "\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u6216\u7B2C\u2462\u7EA7\uFF08outcome-only\uFF09\u3002")
    );
    this.name = "ZcodeReaderError";
    this.code = "engine_session_read_failed";
    this.detail = detail;
  }
};
function parseJsonField(raw, ctx) {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : void 0;
  } catch (err) {
    throw new ZcodeReaderError(
      `${ctx} \u884C data \u4E0D\u662F\u5408\u6CD5 JSON\uFF08${err instanceof Error ? err.message : String(err)}\uFF09`,
      "db \u5185\u5BB9\u635F\u574F\u6216\u7248\u672C\u4E0D\u517C\u5BB9\u2014\u2014\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u3002"
    );
  }
}
function finiteOr2(v, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function usageFromStepFinish(part) {
  const tokens = part.tokens;
  if (typeof tokens !== "object" || tokens === null) return void 0;
  const t = tokens;
  const cache3 = typeof t.cache === "object" && t.cache !== null ? t.cache : {};
  if (t.input === void 0 && t.output === void 0) return void 0;
  return {
    input: finiteOr2(t.input, 0),
    output: finiteOr2(t.output, 0),
    cacheRead: finiteOr2(cache3.read, 0),
    cacheWrite: finiteOr2(cache3.write, 0)
  };
}
function toolFromPart(part) {
  const toolName = typeof part.tool === "string" ? part.tool : "unknown";
  let state;
  if (typeof part.state === "string") {
    try {
      const v = JSON.parse(part.state);
      state = typeof v === "object" && v !== null ? v : void 0;
    } catch {
      state = void 0;
    }
  }
  const status = typeof state?.status === "string" ? state.status : "unknown";
  const output = state?.output;
  return {
    toolName,
    ...state?.input !== void 0 ? { args: state.input } : {},
    // 输出形态（实测）：string（内容）或 object（结构化）——分别映射到 pi ToolCallResult
    // 的 content[] / details，不发明第二形状
    ...typeof output === "string" ? { result: { content: [output] } } : {},
    ...typeof output === "object" && output !== null ? { result: { details: output } } : {},
    ...status !== "completed" ? { isError: true } : {}
  };
}
var TotalsAcc = class {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  cost = 0;
  has = false;
  add(u) {
    this.has = true;
    this.input += u.input;
    this.output += u.output;
    this.cacheRead += u.cacheRead;
    this.cacheWrite += u.cacheWrite;
    this.cost += u.cost ?? 0;
  }
  toTotal() {
    if (!this.has) return void 0;
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      total: this.input + this.output + this.cacheRead + this.cacheWrite
    };
  }
};
function closeTurn(acc, turns, totals) {
  if (acc === null) return;
  turns.push({ text: acc.text, thinking: acc.thinking, toolCalls: acc.toolCalls, closed: true });
  if (acc.usageDelta !== void 0) totals.add(acc.usageDelta);
}
function rowToMessageRow(v) {
  if (typeof v === "object" && v !== null && "id" in v && "data" in v) {
    const r = v;
    if (typeof r.id === "string" && typeof r.data === "string") return { id: r.id, data: r.data };
  }
  throw new ZcodeReaderError("message \u884C\u5F62\u72B6\u5F02\u5E38\uFF08id/data \u5217\u7F3A\u5931\u6216\u7C7B\u578B\u6F02\u79FB\uFF09");
}
function rowToPartRow(v) {
  if (typeof v === "object" && v !== null && "data" in v) {
    const r = v;
    if (typeof r.data === "string") return { data: r.data };
  }
  throw new ZcodeReaderError("part \u884C\u5F62\u72B6\u5F02\u5E38\uFF08data \u5217\u7F3A\u5931\u6216\u7C7B\u578B\u6F02\u79FB\uFF09");
}
function resolveSessionId(db, sessionId) {
  if (sessionId !== void 0) {
    const hit = db.prepare("SELECT id FROM session WHERE id = ?").get(sessionId);
    if (hit === void 0) {
      throw new ZcodeReaderError(
        `session \u4E0D\u5B58\u5728\uFF1A${sessionId}`,
        "sessionId \u53EF\u80FD\u6765\u81EA\u5DF2\u6E05\u7406\u7684\u6C60\u2014\u2014\u964D\u7EA7\u5230 outcome-only\u3002"
      );
    }
    return sessionId;
  }
  const latest = db.prepare("SELECT id FROM session ORDER BY time_created DESC LIMIT 1").get();
  if (latest === void 0 || typeof latest.id !== "string") {
    throw new ZcodeReaderError("db \u5185\u65E0\u4EFB\u4F55 session \u884C");
  }
  return latest.id;
}
function loadGroupedParts(db, sessionId) {
  const grouped = /* @__PURE__ */ new Map();
  for (const raw of db.prepare(
    "SELECT part.message_id AS mid, part.data AS data FROM part JOIN message ON part.message_id = message.id WHERE part.session_id = ? ORDER BY message.sequence, part.sequence"
  ).all(sessionId)) {
    if (typeof raw !== "object" || raw === null || !("mid" in raw)) continue;
    const mid = String(raw.mid);
    const arr = grouped.get(mid) ?? [];
    arr.push(rowToPartRow(raw));
    grouped.set(mid, arr);
  }
  return grouped;
}
function appendPartText(current, part) {
  return current === "" ? String(part.text ?? "") : current + "\n" + String(part.text ?? "");
}
function applyPartToTurn(part, acc, turns, totals) {
  switch (part.type) {
    case "text":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.text = appendPartText(acc.text, part);
      return acc;
    case "reasoning":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.thinking = appendPartText(acc.thinking, part);
      return acc;
    case "tool":
      acc = acc ?? { text: "", thinking: "", toolCalls: [] };
      acc.toolCalls.push(toolFromPart(part));
      return acc;
    case "step-finish": {
      const u = usageFromStepFinish(part);
      const cost = finiteOr2(part.cost, 0);
      if (acc === null) acc = { text: "", thinking: "", toolCalls: [] };
      if (u !== void 0) acc.usageDelta = cost > 0 ? { ...u, cost } : u;
      closeTurn(acc, turns, totals);
      return null;
    }
    default:
      return acc;
  }
}
function collectTurns(messages, grouped, totals) {
  const turns = [];
  for (const msg of messages) {
    const parsedMsg = parseJsonField(msg.data, "message");
    if (parsedMsg?.role !== "assistant") continue;
    let acc = null;
    for (const partRow of grouped.get(msg.id) ?? []) {
      const part = parseJsonField(partRow.data, "part");
      if (part === void 0) continue;
      acc = applyPartToTurn(part, acc, turns, totals);
    }
    closeTurn(acc, turns, totals);
  }
  return turns;
}
function buildView(db, sessionId) {
  const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence").all(sessionId).map(rowToMessageRow);
  const totals = new TotalsAcc();
  const turns = collectTurns(messages, loadGroupedParts(db, sessionId), totals);
  const usageTotal = totals.toTotal();
  return {
    engineId: ZCODE_ENGINE_ID,
    sessionId,
    ...usageTotal !== void 0 ? { usage: usageTotal } : {},
    turns,
    source: "native"
  };
}
async function readZcodeSessionView(dbPath, sessionId) {
  if (!fs3.existsSync(dbPath)) {
    throw new ZcodeReaderError(`db \u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${dbPath}`);
  }
  const sqliteModuleId = "node:sqlite";
  const sqliteMod = await import(sqliteModuleId).catch(() => void 0);
  const DatabaseSyncCtor = sqliteMod?.DatabaseSync;
  if (typeof DatabaseSyncCtor !== "function") {
    throw new ZcodeReaderError(
      "\u5F53\u524D node \u8FD0\u884C\u65F6\u4E0D\u652F\u6301 node:sqlite\uFF08\u9700 >=22.13\uFF09",
      "\u5347\u7EA7 node \u6216\u6539\u7528\u7B2C\u2461\u7EA7\uFF08\u5BBF\u4E3B event journal\uFF09\u8BFB\u53D6\u3002"
    );
  }
  const open2 = DatabaseSyncCtor;
  let db;
  try {
    db = new open2(dbPath, { readOnly: true });
    return buildView(db, resolveSessionId(db, sessionId));
  } catch (err) {
    if (err instanceof ZcodeReaderError) throw err;
    throw new ZcodeReaderError(
      `sqlite \u67E5\u8BE2\u5931\u8D25\uFF08${err instanceof Error ? err.message : String(err)}\uFF09`,
      "\u7591\u4F3C\u8868\u7ED3\u6784\u6F02\u79FB\uFF08zcode schema_migration \u5347\u7EA7\uFF09\u2014\u2014\u8C03\u7528\u65B9\u5E94\u964D\u7EA7\u5230\u7B2C\u2461\u7EA7\uFF1B\u5E76\u628A\u65B0 schema \u6837\u672C\u8865\u5F55\u8FDB golden \u5E93\u540E\u66F4\u65B0 reader\u3002"
    );
  } finally {
    try {
      db?.close();
    } catch (err) {
      void err;
    }
  }
}

// src/execution/engine/engines/zcode/zcode-engine.ts
var logger9 = getLogger("subagents");
var PROBE_VERSION_TIMEOUT_MS = 15e3;
var ZcodeEngine = class {
  id = ZCODE_ENGINE_ID;
  deps;
  probeCache;
  constructor(deps) {
    this.deps = deps;
  }
  /**
   * zcode 链路首期实际接通的能力（D3 链路口径）。声明升级（如 schema 仿真段接入
   * common 层后仍为 emulated；app-server 常驻化后 eventGranularity 升 stream）必须
   * 先改链路再改声明。
   */
  capabilities() {
    return {
      // 无 --json-schema 类通道；公共 schema 仿真层（prompt 约定 + 容错提取 + ajv）
      schemaEnforcement: "emulated",
      // argv-only spawn，无运行中插话通道（app-server 属引擎内部优化，首期不接）
      steer: "unsupported",
      // 无同进程 idle 复用；--resume 是冷启动
      conversation: "unsupported",
      // 无 --append-system-prompt flag（实测拒收）——persona 只能拼进 prompt
      personaInjection: "prompt",
      // stdout 只有终态单 JSON（message_end/turn_end 合成）
      eventGranularity: "coarse",
      // 首期未接 worktree 隔离（公共层 worktree-manager 接入后升 emulated）
      sandbox: "none",
      // sqlite 三级 JOIN 完整重建 turns（reader 实测）
      sessionRead: "full",
      // --resume 冷启动可用（实测）
      resume: "cold",
      // 无原生中断——AbortSignal 走公共杀链（SIGTERM→grace→SIGKILL）
      interrupt: "kill-only",
      // --mode build/edit/plan/yolo 原生权限档位
      permissionMode: "native"
    };
  }
  /** 探针（D7）：二进制存在 + 版本解析 + golden 样本干跑回归（zsub 式逆向契约引擎必做）。 */
  async probe(opts) {
    if (!opts?.force && this.probeCache) return this.probeCache;
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    const binary = this.probeBinaryCheck(cliPath);
    const checks = [binary];
    let engineVersion = "";
    if (binary.ok) {
      const version = await this.probeVersionCheck(cliPath);
      checks.push(version.check);
      engineVersion = version.engineVersion;
    }
    checks.push(this.probeGoldenCheck());
    const ok = checks.every((c) => c.ok);
    const report = {
      ok,
      engineVersion,
      checks,
      ...ok ? {} : { error: this.probeFailureRecovery(cliPath) }
    };
    this.probeCache = report;
    return report;
  }
  /** check 1：二进制存在性（isFile 才算——同名目录不是可执行入口）。 */
  probeBinaryCheck(cliPath) {
    const binaryOk = fs4.existsSync(cliPath) && fs4.statSync(cliPath).isFile();
    return {
      name: "binary",
      ok: binaryOk,
      detail: binaryOk ? cliPath : `zcode CLI \u4E0D\u5B58\u5728\uFF1A${cliPath}`
    };
  }
  /** check 2：`--version` 解析（probeVersion 可注入——测试 fake 防真实子进程）。 */
  async probeVersionCheck(cliPath) {
    const runVersion = this.deps.probeVersion ?? defaultProbeVersion;
    const version = await runVersion(cliPath);
    const versionOk = version !== void 0 && version.length > 0;
    return {
      check: {
        name: "version",
        ok: versionOk,
        detail: versionOk ? version : "zcode --version \u8FD4\u56DE\u7A7A\u6216\u5931\u8D25"
      },
      engineVersion: version ?? ""
    };
  }
  /** check 3：golden 样本干跑（parser 对实录样本解析——stdout 格式漂移的入口拦截）。 */
  probeGoldenCheck() {
    const golden = parseZcodeTerminal(ZCODE_GOLDEN_STDOUT);
    const goldenOk = golden.ok && golden.payload.sessionId !== void 0 && golden.payload.usage !== void 0;
    return {
      name: "golden-regression",
      ok: goldenOk,
      detail: goldenOk ? "parser \u5BF9 0.16.5 \u5B9E\u5F55\u6837\u672C\u56DE\u5F52\u901A\u8FC7\uFF08sessionId/response/usage \u5F62\u72B6\u5B8C\u6574\uFF09" : `\u89E3\u6790\u5B9E\u5F55\u6837\u672C\u5931\u8D25\uFF1A${golden.ok ? "\u5B57\u6BB5\u7F3A\u5931\uFF08sessionId/usage\uFF09" : golden.reason}`
    };
  }
  /** 探针失败的恢复指引（§3.3.3 终态四：版本确认命令 + 探针重跑 + 调研文档路径）。 */
  probeFailureRecovery(cliPath) {
    return {
      code: "engine_probe_failed",
      recovery: `Run \`node ${cliPath} --version\` \u786E\u8BA4 zcode CLI \u53EF\u7528\u4E14\u7248\u672C\u672A\u6F02\u79FB\uFF0C\u7136\u540E\u91CD\u8DD1\u63A2\u9488\uFF08\u91CD\u65B0\u521D\u59CB\u5316\u5F15\u64CE\u6216 probe({force:true})\uFF09\u3002\u82E5 stdout \u683C\u5F0F\u5DF2\u53D8\uFF1A\u628A\u65B0\u6837\u672C\u8865\u5F55\u8FDB golden \u5E93\uFF08__tests__/__fixtures__/zcode-golden-spawn.json \u4E0E golden-sample.ts\uFF09\u5E76\u66F4\u65B0 parser\u3002\u53C2\u7167 docs/research/agent-engine-zcode.md\u3002`
    };
  }
  /** D1 主语义：preparer → launcher → parser →（schema 仿真校验 + 一次重试）→ outcome/handle。 */
  async run(task, ctx) {
    const startedAt = Date.now();
    this.rejectUnsupportedTaskShapes(task);
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    const prepared = prepareZcodeHome({
      engineDataDir: this.deps.engineDataDir(),
      modelRef,
      sources: this.deps.sources
    });
    ctx.onPoolResolved?.(prepared.poolKey);
    logger9.debug("[zcode-engine] isolated home prepared", {
      poolKey: prepared.poolKey,
      wroteConfig: prepared.wroteConfig,
      modelRef,
      taskId: ctx.taskId
    });
    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject3(task.schema) ? task.schema : void 0;
    const basePrompt = this.buildPrompt(task, schema);
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    let final = await this.attemptOnce(task, ctx, prepared, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    if (final.kind === "parsed" && final.schemaResult !== void 0 && !final.schemaResult.ok && schema !== void 0) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptOnce(task, ctx, prepared, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);
    const handle = {
      data: {
        v: 1,
        engineId: ZCODE_ENGINE_ID,
        sessionRef: {
          // 相对池目录自描述（设计 §3.3.6）——read 时经 resolvePoolDir + 此相对路径重定位
          dbPath: ZCODE_POOL_DB_RELATIVE_PATH,
          ...outcome.sessionId !== void 0 ? { sessionId: outcome.sessionId } : {}
        },
        poolKey: prepared.poolKey,
        ...this.probeCache?.engineVersion !== void 0 && this.probeCache.engineVersion !== "" ? { engineVersion: this.probeCache.engineVersion } : {},
        adapterVersion: ZCODE_ADAPTER_VERSION
      }
    };
    return { handle, outcome };
  }
  /** 终态合成（extension-conventions 函数 80 行上限，从 run 提取）：aborted / run-failed / parsed 三分支。 */
  finalizeOutcome(task, ctx, final, usageAcc, startedAt) {
    const outcome = {
      engineId: ZCODE_ENGINE_ID,
      content: "",
      durationMs: Date.now() - startedAt,
      ...typeof task.worktree === "object" && task.worktree !== null ? { worktreePath: task.worktree.path } : {},
      // D9① fallback 留痕：路由层经 RunContext 投影（zcode 无 record 通路，outcome 是
      // 唯一留痕面；pi 引擎另有 record 投影）
      ...ctx.engineFallback !== void 0 ? { engineFallback: ctx.engineFallback } : {}
    };
    const emit = (event) => {
      ctx.onEvent?.(event);
    };
    if (final.kind === "aborted") {
      this.applyAbortedOutcome(outcome, task, ctx, final, emit);
    } else if (final.kind === "run-failed") {
      this.applyRunFailedOutcome(outcome, final, emit);
    } else {
      this.applyParsedOutcome(outcome, final, usageAcc, emit);
    }
    return outcome;
  }
  /** abort 合成终态：exitCode=null（record 正常收尾，不留僵尸）。 */
  applyAbortedOutcome(outcome, task, ctx, final, emit) {
    outcome.exitCode = null;
    outcome.error = isHostTimeoutAbort(ctx) ? synthesizeTimeoutOutcome(task, final.output.stdoutText, ZCODE_ENGINE_ID).error ?? engineTimeoutDetail(final.output.stdoutText) : `engine_run_failed: zcode \u4EFB\u52A1\u88AB\u4E2D\u6B62\uFF08\u6740\u94FE SIGTERM\u2192${ZCODE_KILL_GRACE_MS}ms\u2192SIGKILL\uFF0C\u5BBF\u4E3B\u5408\u6210\u7EC8\u6001\uFF09\u3002stdout \u5C3E\u90E8: ${final.output.stdoutText.slice(-ZCODE_ERROR_TAIL_CHARS)}`;
    emit({ type: "error", message: outcome.error });
  }
  /** run-failed 合成终态：错误信息由 buildRunFailedMessage 产出（已含恢复指引），直接透传。 */
  applyRunFailedOutcome(outcome, final, emit) {
    outcome.exitCode = final.output.exitCode;
    outcome.error = final.message;
    emit({ type: "error", message: outcome.error });
  }
  /** parsed 合成终态：content/sessionId/usage 落位 + schema 校验分流 + coarse 事件。 */
  applyParsedOutcome(outcome, final, usageAcc, emit) {
    const payload = final.payload;
    outcome.content = payload.response;
    outcome.exitCode = final.output.exitCode;
    if (payload.sessionId !== void 0) outcome.sessionId = payload.sessionId;
    if (usageAcc.has) {
      const last = payload.outcomeUsage;
      outcome.usage = {
        input: usageAcc.input,
        output: usageAcc.output,
        cacheRead: usageAcc.cacheRead,
        cacheWrite: usageAcc.cacheWrite,
        cost: 0,
        contextTokens: last?.contextTokens ?? usageAcc.input + usageAcc.output + usageAcc.cacheRead + usageAcc.cacheWrite,
        turns: last?.turns ?? 1
      };
    }
    if (final.schemaResult !== void 0) {
      if (final.schemaResult.ok) {
        outcome.parsedOutput = final.schemaResult.parsed;
      } else {
        outcome.error = `schema_emulation_failed: zcode \u8F93\u51FA\u7ECF\u4E24\u8F6E\uFF08\u542B\u5F3A\u5316 prompt \u91CD\u8BD5\uFF09\u4ECD\u672A\u901A\u8FC7 schema \u6821\u9A8C\u3002\u672B\u8F6E\u5931\u8D25\u539F\u56E0: ${final.schemaResult.error}\u3002\u539F\u59CB\u8F93\u51FA\u5C3E\u90E8: ${final.schemaResult.tail}\u3002\u6062\u590D\u6307\u5F15\uFF1A\u7B80\u5316 schema \u6216\u62C6\u5C0F\u4EFB\u52A1\u540E\u91CD\u6D3E\uFF1B\u9700\u8981\u5F3A schema \u7EA6\u675F\u65F6\u6539\u7528 engine: pi\uFF08native schema \u6CE8\u5165\uFF09\u3002`;
        emit({ type: "error", message: outcome.error });
      }
    }
    for (const ev of synthesizeCoarseEvents(payload.response, payload.usage)) emit(ev);
  }
  /**
   * 单轮执行（launch → collect → parse → schema 校验）。产出三态之一给 run 编排：
   * aborted（我方杀链）/ run-failed（非零退出或解析失败）/ parsed（含 schema 校验结果）。
   */
  async attemptOnce(task, ctx, prepared, cwd, prompt) {
    const args = buildZcodeArgv({ cwd, prompt, denyTools: task.denyTools });
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    assertZcodeArgvBudget("node", cliPath, args);
    const launch = this.deps.launch ?? launchZcodeProcess;
    const env = buildZcodeEnv(prepared.homeDir, this.deps.processEnv ?? process.env);
    let proc;
    try {
      proc = launch({ cliPath, args, env });
    } catch (err) {
      throw new Error(
        `[engine_run_failed] \u65E0\u6CD5\u542F\u52A8 zcode CLI\uFF08${cliPath}\uFF09\uFF1A${err instanceof Error ? err.message : String(err)}\u3002\u6062\u590D\u6307\u5F15\uFF1A\u786E\u8BA4 node \u5728 PATH \u4E14 ${cliPath} \u5B58\u5728\uFF08probe \u53EF\u63A2\u6D4B\uFF09\uFF0C\u6216\u6539\u7528 engine: pi\u3002`
      );
    }
    ctx.onChildSpawned?.(proc.child);
    const onAbort = () => {
      void proc.abort(ZCODE_KILL_GRACE_MS);
    };
    if (ctx.signal !== void 0) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }
    const output = await collectZcodeOutput(proc);
    if (ctx.signal !== void 0) ctx.signal.removeEventListener("abort", onAbort);
    if (proc.killedByUs()) return { kind: "aborted", output };
    if (output.exitCode !== 0) {
      return {
        kind: "run-failed",
        output,
        message: buildRunFailedMessage({
          cliPath,
          exitCode: output.exitCode,
          stdoutTail: output.stdoutText,
          stderrTail: output.stderrTail,
          modelRef: prepared.modelRef,
          configPath: prepared.configPath
        })
      };
    }
    const terminal = parseZcodeTerminal(output.stdoutText);
    if (!terminal.ok) {
      return {
        kind: "run-failed",
        output,
        message: buildRunFailedMessage({
          cliPath,
          exitCode: output.exitCode,
          stdoutTail: output.stdoutText,
          stderrTail: output.stderrTail,
          parseReason: terminal.reason,
          modelRef: prepared.modelRef,
          configPath: prepared.configPath
        })
      };
    }
    const schema = isPlainObject3(task.schema) ? task.schema : void 0;
    return {
      kind: "parsed",
      output,
      payload: terminal.payload,
      ...schema !== void 0 ? { schemaResult: extractAndValidateStructuredOutput(terminal.payload.response, schema) } : {}
    };
  }
  /**
   * D1 可选面：zcode 首期不支持 conversation（capabilities 声明）——同步拒绝、
   * 不创建进程，文案给可操作建议（A11）。
   */
  async interact(_handle, _action) {
    return {
      ok: false,
      code: "engine_capability_unsupported",
      message: "zcode \u5F15\u64CE\u4E0D\u652F\u6301 conversation \u4EA4\u4E92\u63A7\u5236\u9762\uFF08capabilities.conversation = 'unsupported'\uFF0Cspawn \u5355\u8F6E\u6A21\u5F0F\u65E0\u540C\u8FDB\u7A0B idle \u590D\u7528\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u6539\u7528\u5355\u6B21 subagent \u8C03\u7528\u91CD\u65B0\u6D3E\u53D1\u4EFB\u52A1\uFF0C\u6216\u4F7F\u7528 engine: 'pi'\uFF08chatMode idle \u590D\u7528\uFF0C\u652F\u6301 message/close/cancel\uFF09\u3002"
    };
  }
  /**
   * D6 read 三级降级：①sqlite 原生读取 → ②宿主 event journal 重放（对齐点①接线：
   * replayJournalToSessionView 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   * sessionId 缺失（解析失败的 run 无法在共享池 db 内定位 session）跳过①级；②级
   * 依赖 handle.journalPath（宿主 run 后回填）。
   */
  /** [U7] 模型可发现性：v2 桌面登录态聚合（带凭据 provider × models），失败安全返回清单本身可能为空。 */
  listModels() {
    return listZcodeModels(this.deps.sources);
  }
  async read(handle) {
    if (handle.data.engineId !== ZCODE_ENGINE_ID) {
      return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    const sessionId = handle.data.sessionRef["sessionId"];
    const dbPathRaw = handle.data.sessionRef["dbPath"];
    if (typeof sessionId === "string" && typeof dbPathRaw === "string") {
      const dbPath = path3.isAbsolute(dbPathRaw) ? dbPathRaw : path3.join(resolvePoolDir(this.deps.engineDataDir(), ZCODE_ENGINE_ID, handle.data.poolKey), dbPathRaw);
      try {
        return await readZcodeSessionView(dbPath, sessionId);
      } catch (err) {
        logger9.warn("[zcode-engine] native session read failed, degrade to journal replay", {
          dbPath,
          sessionId,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const journaled = replayJournalToSessionView(handle, ZCODE_ENGINE_ID);
    if (journaled !== void 0) return journaled;
    return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
  }
  // ── 内部 ──
  /**
   * prepare 期的能力拒绝（进程创建前）：fork 是 pi 专属（AgentTaskSpec.fork 契约：
   * 其他引擎按 capabilities 拒绝）；conversation 是 interact 控制面的 task 标志，
   * zcode 无此面（A11：同步拒绝 + 可操作建议，无进程创建）；maxTurns 是 pi 引擎
   * 专属（turn limiter + spawn watchdog 估算依赖 pi 的 turn_end 事件流）——zcode
   * 无 turn_end 语义，静默丢弃会造成「传了上限却失控」的假象，显式拒绝（U4，
   * 同 fork 模式）。
   */
  rejectUnsupportedTaskShapes(task) {
    if (task.fork === true) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode \u5F15\u64CE\u4E0D\u652F\u6301 fork\uFF08pi \u4E13\u5C5E\u4F1A\u8BDD\u5206\u53C9\u8BED\u4E49\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u53BB\u6389 fork \u53C2\u6570\u91CD\u6D3E\uFF0C\u6216\u4F7F\u7528 engine: 'pi'\u3002"
      );
    }
    if (task.conversation === true) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode \u5F15\u64CE\u4E0D\u652F\u6301 conversation \u6A21\u5F0F\uFF08spawn \u5355\u8F6E\uFF0C\u65E0\u540C\u8FDB\u7A0B idle \u590D\u7528\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u6539\u7528\u5355\u6B21\u8C03\u7528\uFF08\u53BB\u6389 conversation\uFF09\uFF0C\u6216\u4F7F\u7528 engine: 'pi'\u3002"
      );
    }
    if (task.maxTurns !== void 0) {
      throw new ZcodeTaskShapeError(
        "engine_capability_unsupported",
        "zcode \u5F15\u64CE\u4E0D\u652F\u6301 maxTurns\uFF08pi \u5F15\u64CE\u4E13\u5C5E turn limiter\uFF1Bzcode \u65E0 turn_end \u8BED\u4E49\uFF0C\u65E0\u6CD5\u5151\u73B0\u8F6E\u6570\u4E0A\u9650\uFF09\u3002\u6062\u590D\u6307\u5F15\uFF1A\u53BB\u6389 maxTurns \u53C2\u6570\u91CD\u6D3E\uFF0C\u6216\u4F7F\u7528 engine: 'pi'\u3002"
      );
    }
  }
  /**
   * persona 拼接后的完整 prompt（personaInjection: 'prompt'——zcode 无 flag 通道）：
   * appendSystemPrompt 段在前（人设/约束语境），task 正文居中，schema 仿真段尾置
   * （common/schema-emulation 公共层产出，D4 emulated 侧——zcode 无 native schema 通道）。
   */
  buildPrompt(task, schema) {
    const segments = [...task.persona?.appendSystemPrompt ?? []];
    segments.push(task.task);
    if (schema !== void 0) segments.push(buildSchemaEmulationSegment(schema));
    return segments.join("\n\n");
  }
};
function isPlainObject3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function accumulateUsage(acc, r) {
  if (r.kind !== "parsed") return;
  const u = r.payload.usage;
  if (u === void 0) return;
  acc.has = true;
  acc.input += u.input;
  acc.output += u.output;
  acc.cacheRead += u.cacheRead;
  acc.cacheWrite += u.cacheWrite;
}
function appendSchemaRetryDirective(basePrompt, validationError) {
  return basePrompt + `

## Retry: Structured Output Failed
Your previous answer failed schema validation: ${validationError}
Answer again. Output ONLY the JSON value conforming to the schema above \u2014 no prose, no markdown fences, no extra text.`;
}
var ZcodeTaskShapeError = class extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "ZcodeTaskShapeError";
    this.code = code;
  }
};
function isHostTimeoutAbort(ctx) {
  return ctx.signal?.aborted === true && ctx.signal.reason === HOST_TIMEOUT_ABORT_REASON;
}
async function defaultProbeVersion(cliPath) {
  try {
    return await new Promise((resolve4, reject) => {
      (0, import_node_child_process2.execFile)(
        "node",
        [cliPath, "--version"],
        { encoding: "utf8", timeout: PROBE_VERSION_TIMEOUT_MS },
        (err, stdout) => {
          if (err) reject(err);
          else resolve4(stdout.trim().split("\n")[0]?.trim() || void 0);
        }
      );
    });
  } catch (err) {
    logger9.debug(
      `[zcode-engine] probe version check failed (best-effort continue): ${err instanceof Error ? err.message : String(err)}`
    );
    return void 0;
  }
}

// src/execution/engine/engines/zcode/registration.ts
function createZcodeEngine(deps) {
  return new ZcodeEngine(deps);
}
function registerZcodeEngine(engineDataDir = getEngineDataDir) {
  registerEngine(
    ZCODE_ENGINE_ID,
    () => createZcodeEngine({
      engineDataDir,
      ...process.env["XYZ_ZCODE_CLI"] !== void 0 ? { cliPath: process.env["XYZ_ZCODE_CLI"] } : {}
    })
  );
}

// src/execution/session-runner.ts
var import_node_child_process3 = require("child_process");
var fs10 = __toESM(require("fs"), 1);

// src/execution/best-effort.ts
var logger10 = getLogger("subagents");

// src/execution/lifecycle-manager.ts
var MS_PER_SECOND = 1e3;
var SECONDS_PER_MINUTE = 60;
var IDLE_TIMEOUT_MINUTES = 5;
var DEFAULT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
var ACTIVATE_LOCK_TIMEOUT_SECONDS = 30;
var ACTIVATE_LOCK_TIMEOUT_MS = ACTIVATE_LOCK_TIMEOUT_SECONDS * MS_PER_SECOND;

// src/execution/session-pending.ts
var fs5 = __toESM(require("fs"), 1);
var logger11 = getLogger("subagents");

// src/execution/alive-store.ts
var fs6 = __toESM(require("fs"), 1);

// src/execution/stdin-writer.ts
var crypto = __toESM(require("crypto"), 1);
var logger12 = getLogger("subagents");

// src/execution/path-encoding.ts
var path4 = __toESM(require("path"), 1);

// src/execution/pi-invocation.ts
var fs7 = __toESM(require("fs"), 1);
var path5 = __toESM(require("path"), 1);

// src/shared/schema-env.ts
var BYTES_PER_KIB = 1024;
var SCHEMA_ENV_MAX_KIB = 256;
var SCHEMA_ENV_MAX_BYTES = SCHEMA_ENV_MAX_KIB * BYTES_PER_KIB;

// src/execution/spawn-event-adapter.ts
var fs8 = __toESM(require("fs"), 1);
var path6 = __toESM(require("path"), 1);

// src/execution/temp-prompt.ts
var fs9 = __toESM(require("fs"), 1);
var os2 = __toESM(require("os"), 1);
var path7 = __toESM(require("path"), 1);

// src/execution/turn-limiter.ts
var WRAP_UP_MESSAGE = [
  "You have reached your turn limit. Wrap up now:",
  "1. Summarize what you have completed (with evidence: file paths, command output).",
  "2. List what remains undone and why.",
  "3. State the single most important next step for whoever continues.",
  "Do NOT claim the task is complete if any part remains unfinished."
].join(" ");
var WRAP_UP_HINT = [
  `You have a turn limit. As you sense you are approaching it, proactively wrap up:`,
  "1. Summarize what you have completed (with evidence: file paths, command output).",
  "2. List what remains undone and why.",
  "3. State the single most important next step for whoever continues.",
  "Do NOT claim the task is complete if any part remains unfinished."
].join(" ");

// src/execution/ui-request-observability.ts
var logger13 = getLogger("subagents");

// src/execution/ui-request-queue.ts
var logger14 = getLogger("subagents");

// src/execution/session-runner.ts
var logger15 = getLogger("subagents");
var MS_PER_SECOND2 = 1e3;
var SECONDS_PER_MINUTE2 = 60;
var WATCHDOG_FLOOR_MINUTES = 30;
var SPAWN_WATCHDOG_FLOOR_MS = WATCHDOG_FLOOR_MINUTES * SECONDS_PER_MINUTE2 * MS_PER_SECOND2;
var WATCHDOG_MINUTES_PER_TURN = 5;
var WATCHDOG_MS_PER_TURN = WATCHDOG_MINUTES_PER_TURN * SECONDS_PER_MINUTE2 * MS_PER_SECOND2;
var ASK_USER_RPC_PROMPT = `
## ask_user Tool Availability

The \`ask_user\` tool is available in this session. When you call \`ask_user\`, your questions are forwarded via RPC to the main agent's UI, where the user will see them and provide answers. The response is delivered back to you automatically.

**How it works:**
1. You call \`ask_user\` with structured questions (each with options)
2. The questions are forwarded to the main agent's UI via RPC
3. The user sees the questions and selects answers in the main agent interface
4. The answers are returned to you as the tool result

**Important:**
- The user may take some time to respond \u2014 this is normal
- If the user cancels or the request times out, you'll receive a cancellation notice
- Use ask_user only when you genuinely cannot resolve ambiguity yourself (see tool description for guidelines)
`.trim();
var WORKTREE_GUIDANCE_PROMPT = `
## Working Directory Is a Git Worktree

Your working directory (the "Working directory" in the environment block above) is a **dedicated git worktree** \u2014 an isolated checkout of the repository at HEAD, NOT a temporary sandbox. It contains the **complete project source code**.

**You should:**
- Work directly in your current cwd \u2014 it already has the full project (every file). Read project files via relative paths as usual.
- To locate the shared repository root: \`git rev-parse --git-common-dir\`.
- Your file changes are automatically captured as a patch when you finish \u2014 just do the work; no need to commit, push, or merge.

**Do NOT** \`cd\` to another directory looking for "the real project" \u2014 your cwd IS the project. A path like \`/private/var/folders/.../pi-subagents/.../pi-sub-<id>\` is your worktree checkout, not an empty sandbox.
`.trim();
var spawnedChildren = /* @__PURE__ */ new Map();
function killAllSpawnedChildren(signal = "SIGTERM") {
  let n = 0;
  for (const child of spawnedChildren.values()) {
    if (child.killed) continue;
    try {
      child.kill(signal);
      n++;
    } catch (err) {
      logger15.debug(
        `[session-runner] killAllSpawnedChildren: kill failed (best-effort continue): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  spawnedChildren.clear();
  return n;
}
var SIGKILL_ESCALATION_SECONDS = 30;
var SIGKILL_ESCALATION_MS = SIGKILL_ESCALATION_SECONDS * MS_PER_SECOND2;

// src/index.ts
var CORE_PACKAGE_VERSION = "0.2.0";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CORE_PACKAGE_VERSION,
  DEFAULT_DATA_ROOT,
  FileRunStore,
  MAX_RETAINED_DONE_RUNS,
  WorkerHostImpl,
  WorkflowScriptRegistryImpl,
  abortRun,
  configureCore,
  configureNotifyDomain,
  createZcodeEngine,
  discoverWorkflows,
  evictDoneRunsBeyondCap,
  executeNestedWorkflow,
  getLogger,
  getWorkflow,
  getWorkflowByPath,
  invalidateCache,
  killAllSpawnedChildren,
  lintScript,
  loadWorkflows,
  registerZcodeEngine,
  routeEngine,
  runAndWait,
  runWorkflow,
  scheduleTimeBudget,
  terminateRunningRuns
});
