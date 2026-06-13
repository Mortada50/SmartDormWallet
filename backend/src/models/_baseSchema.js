/**
 * @file _baseSchema.js
 * @description Shared Mongoose Schema factory enforcing system-wide architectural rules.
 *
 * Every model in this system is built on top of createBaseSchema() to guarantee:
 *
 *  1. PUBLIC ID RULE — `publicId` (UUID v4) is the ONLY external identifier.
 *     `_id` and `__v` are stripped from all JSON/Object serialisation.
 *
 *  2. NO AUTO-CREATE / NO AUTO-INDEX — Mongoose must not touch collection
 *     structure. All collections and indexes are managed by createCollections.js.
 *
 *  3. TIMESTAMPS — `createdAt` and `updatedAt` are added automatically by
 *     Mongoose's built-in timestamps option (not manual pre-save hooks).
 *
 *  4. LEAN HINTS — Query helpers `.asLean()` and `.asLeanOne()` are injected
 *     on every schema to remind developers to call .lean() on read-only queries.
 *
 *  5. NO BUSINESS LOGIC IN HOOKS — Pre/post hooks in individual models may
 *     only perform: publicId generation, updatedAt (handled by timestamps option).
 *     Financial calculations and encryption happen in the Service layer only.
 *
 * @module models/_baseSchema
 */

'use strict';

const { Schema } = require('mongoose');
const { randomUUID } = require('crypto');

/**
 * Creates a Mongoose SchemaOptions object with all base settings applied.
 *
 * @param {object} [extraOptions={}] - Additional schema options to merge.
 * @returns {object} Merged schema options.
 */
function baseSchemaOptions(extraOptions = {}) {
  return {
    // ── Collection management ──────────────────────────────────────────────
    // Mongoose must NOT auto-create collections or indexes.
    // This is handled exclusively by src/db/createCollections.js.
    autoCreate: false,
    autoIndex: false,

    // ── Timestamps ────────────────────────────────────────────────────────
    timestamps: true, // adds createdAt + updatedAt automatically

    // ── Serialisation — Public ID Rule ────────────────────────────────────
    // Strip _id and __v from all toJSON() / toObject() calls.
    // publicId is the ONLY identifier exposed outside the DB layer.
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      versionKey: false,
      transform(doc, ret) {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },

    ...extraOptions,
  };
}

/**
 * The shared publicId field definition added to every schema.
 * Generated automatically in a pre-validate hook; never set by the caller.
 */
const PUBLIC_ID_FIELD = {
  publicId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    // Default generator — overridden per-model if needed
    default: () => randomUUID(),
  },
};

/**
 * Injects shared query helpers onto a schema instance.
 *
 * Available helpers:
 *   Model.find(...).asLean()     → equivalent to .lean({ virtuals: false })
 *   Model.findOne(...).asLean()  → same
 *
 * Use `.lean()` for ALL read-only queries that do not need Mongoose document
 * methods (save, updateOne, etc.). This reduces memory allocation by ~3–5×
 * for large result sets.
 *
 * @param {Schema} schema
 */
function injectLeanHelpers(schema) {
  schema.query.asLean = function () {
    return this.lean();
  };

  schema.query.asLeanOne = function () {
    return this.lean().limit(1);
  };
}

/**
 * Attaches a pre-validate hook that auto-generates `publicId` if absent.
 * This is the ONLY allowed hook in the model layer — it performs no business logic.
 *
 * @param {Schema} schema
 */
function injectPublicIdHook(schema) {
  schema.pre('validate', function (next) {
    if (!this.publicId) {
      this.publicId = randomUUID();
    }
    next();
  });
}

/**
 * Creates a fully configured Mongoose Schema with all base rules applied.
 *
 * @param {object} definition   - Mongoose schema field definitions.
 * @param {object} [options={}] - Extra schema options (merged with base options).
 * @returns {Schema} A configured Mongoose Schema instance.
 *
 * @example
 *   const { createBaseSchema } = require('./_baseSchema');
 *   const schema = createBaseSchema({ name: { type: String, required: true } });
 *   module.exports = mongoose.model('MyModel', schema);
 */
function createBaseSchema(definition = {}, options = {}) {
  const schema = new Schema(
    { ...PUBLIC_ID_FIELD, ...definition },
    baseSchemaOptions(options)
  );

  injectPublicIdHook(schema);
  injectLeanHelpers(schema);

  return schema;
}

module.exports = { createBaseSchema, baseSchemaOptions, PUBLIC_ID_FIELD };
