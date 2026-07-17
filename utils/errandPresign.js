const r2Service = require('../services/r2Service');

// Attaches a short-lived signed URL for the runner's proof-of-completion
// photo (if one was uploaded) so the customer/runner/admin apps can display it.
exports.attachProofPhotoUrl = async (errand) => {
  if (errand.proofPhotoKey) {
    errand.proofPhotoUrl = await r2Service.getSignedDownloadUrl(errand.proofPhotoKey, 3600);
  }
  return errand;
};
