const mongoose = require('mongoose');

// One document per legal content type (terms, privacy). Legacy documents
// created before `type` existed have no value here — controllers fall back
// to treating an untyped document as 'terms' for backward compatibility.
const legalContentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['terms', 'privacy'], default: 'terms' },
    content: { type: String, required: true, default: '' },
    // Used only by 'privacy' — rendered as an accordion of sections.
    sections: [
      {
        title: { type: String, required: true },
        body: { type: String, required: true },
        order: { type: Number, default: 0 },
      },
    ],
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('LegalContent', legalContentSchema);
