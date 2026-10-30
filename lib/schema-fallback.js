/**
 * Minimal stand-in for @deepseek-ai/schemastery.
 *
 * The real package is a core dependency of the dsh host, so a mounted plugin
 * always has it. But a fresh clone running `npm test` does not, and a hard
 * top-level import there turns a missing dev dependency into a module-load
 * crash that looks like a broken plugin. This shim keeps the same chainable
 * surface the plugin actually uses (object/string/boolean, default,
 * description) so config defaults still resolve either way.
 *
 * It is deliberately not a validator: it only carries defaults, which is all
 * the plugin reads at runtime.
 */

class Field {
  constructor(kind, value) {
    this.kind = kind
    this.value = value
    this.meta = { default: undefined, description: '' }
  }

  default(value) {
    this.meta.default = value
    return this
  }

  description(text) {
    this.meta.description = text
    return this
  }

  /** Resolve to the declared default, matching schemastery's shape closely enough. */
  toValue() {
    return this.meta.default
  }
}

const string = () => new Field('string')
const boolean = () => new Field('boolean')
const number = () => new Field('number')

function object(dict) {
  const resolve = (input = {}) => {
    const out = {}
    for (const [key, field] of Object.entries(dict)) {
      const given = input?.[key]
      out[key] = given === undefined ? field.meta?.default : given
    }
    return out
  }
  // The host reads `.dict` to render settings fields.
  resolve.dict = dict
  return resolve
}

const Schema = { string, boolean, number, object }

export default Schema
