const express = require('express');
const router = express.Router();
const locationController = require('../controllers/locationController');

// Public — runner has verified phone but not yet logged in, same trust
// model as /api/verification/upload-urls and /submit.
router.get('/', locationController.getActiveAreas);

module.exports = router;
