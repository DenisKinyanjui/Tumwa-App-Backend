const mongoose = require('mongoose');

// Runner-facing list of operating areas — shown as checkboxes during identity
// verification (see verificationController / RunnerVerification.areasOfOperation)
// and managed by admins via locationController. Errand addresses are bucketed
// into these by name match for the "top regions" analytics (analyticsService
// buildRegionExpr).
const serviceAreaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Area name is required'],
      trim: true,
      unique: true,
      maxlength: [60, 'Area name cannot exceed 60 characters'],
    },
    // Broader county/region this zone belongs to (e.g. "Nairobi", "Kiambu") —
    // purely descriptive, not used for address matching.
    region: {
      type: String,
      trim: true,
      default: '',
      maxlength: [60, 'Region cannot exceed 60 characters'],
    },
    // active     — runners can select it, counted as live coverage
    // inactive   — temporarily hidden from runners, may return
    // retired    — Tumwa no longer serves this area (kept for historical records)
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'retired'],
        message: 'Invalid zone status',
      },
      default: 'active',
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    // True for zones created automatically from a customer's geocoded
    // errand location (see serviceAreaService.registerZone), false for
    // zones an admin typed in themselves. Cleared to false the moment an
    // admin edits the zone — it's a "needs review" flag, not provenance
    // that should persist forever.
    autoDetected: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

serviceAreaSchema.index({ status: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('ServiceArea', serviceAreaSchema);
