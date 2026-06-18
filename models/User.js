const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: ['admin', 'verifier', 'reporter'],
      required: true,
      default: 'reporter',
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      required: true,
      default: 'local',
    },
    googleId: {
      type: String,
      default: undefined,
    },
    email: {
      type: String,
      default: undefined,
      trim: true,
      lowercase: true,
    },
    displayName: {
      type: String,
      default: null,
      trim: true,
    },
    otp: {
      codeHash: {
        type: String,
        default: null,
      },
      purpose: {
        type: String,
        enum: ['login', 'reset_password', null],
        default: null,
      },
      expiresAt: {
        type: String,
        default: null,
      },
      requestedAt: {
        type: String,
        default: null,
      },
    },
    createdAt: {
      type: String,
      default: () => new Date().toISOString(),
    },
  },
  {
    versionKey: false,
    collection: 'users',
  }
);

UserSchema.index(
  { googleId: 1 },
  {
    unique: true,
    partialFilterExpression: { googleId: { $type: 'string' } },
  }
);
UserSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string' } },
  }
);

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
