const mongoose = require('mongoose');

const savedAddressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    label: {
      type: String,
      required: [true, 'Address label is required'],
      trim: true,
      maxlength: 50,
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
      maxlength: 300,
    },
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    tag: {
      type: String,
      enum: ['Home', 'Work', 'Other'],
      default: 'Other',
    },
    isDefault: { type: Boolean, default: false },
    isFavorite: { type: Boolean, default: false },
  },
  { timestamps: true }
);

savedAddressSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SavedAddress', savedAddressSchema);
