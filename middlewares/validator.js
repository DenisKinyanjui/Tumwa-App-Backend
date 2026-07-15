/**
 * Input validation middleware using Joi.
 *
 * Usage:
 *   router.post('/register', validate(schemas.register), authController.register);
 *
 * All schemas strip unknown fields by default (allowUnknown: false).
 * Validation errors return 422 with an array of messages.
 */

const Joi = require('joi');

// ── Phone number pattern ──────────────────────────────────────────────────────
// Accepts: 07XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX, +254 7XX XXX XXX
const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

// ── Reusable field definitions ────────────────────────────────────────────────
const fields = {
  phone: Joi.string().pattern(PHONE_REGEX).messages({
    'string.pattern.base': 'Phone must be a valid international number (e.g. +2547XXXXXXXX)',
  }),

  password: Joi.string().min(8).max(128).pattern(/^(?=.*[A-Za-z])(?=.*\d)/).messages({
    'string.min': 'Password must be at least 8 characters',
    'string.pattern.base': 'Password must contain at least one letter and one number',
  }),

  objectId: Joi.string().hex().length(24).messages({
    'string.hex': 'Must be a valid ID',
    'string.length': 'Must be a valid ID',
  }),

  positiveNumber: Joi.number().positive().messages({
    'number.positive': 'Must be a positive number',
    'number.base': 'Must be a number',
  }),

  pagination: {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(20),
  },
};

// ── Auth schemas ──────────────────────────────────────────────────────────────

const register = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).optional(),
  phone: fields.phone.required(),
  password: fields.password.required(),
  role: Joi.string().valid('customer', 'runner').default('customer'),
});

const login = Joi.object({
  identifier: Joi.string().trim().min(3).max(254).required().messages({
    'any.required': 'Phone number or email is required',
    'string.empty': 'Phone number or email is required',
  }),
  password: Joi.string().required().messages({ 'any.required': 'Password is required' }),
});

const changePassword = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: fields.password.required(),
});

const sendOtp = Joi.object({
  phone: fields.phone.required(),
});

const verifyOtp = Joi.object({
  phone: fields.phone.required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required().messages({
    'string.length': 'OTP must be exactly 6 digits',
    'string.pattern.base': 'OTP must contain only digits',
  }),
});

const forgotPassword = Joi.object({
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).required(),
});

const resetPassword = Joi.object({
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).required(),
  code: Joi.string().length(6).pattern(/^\d+$/).required().messages({
    'string.length': 'Code must be exactly 6 digits',
    'string.pattern.base': 'Code must contain only digits',
  }),
  newPassword: fields.password.required(),
});

const googleAuth = Joi.object({
  idToken: Joi.string().required(),
});

const completePhone = Joi.object({
  phone: fields.phone.required(),
});

// ── Errand schemas ────────────────────────────────────────────────────────────

const createErrand = Joi.object({
  title: Joi.string().trim().min(3).max(100).required(),
  description: Joi.string().trim().min(10).max(1000).required(),
  location: Joi.object({
    address: Joi.string().trim().min(3).max(300).required(),
    coordinates: Joi.object({
      lat: Joi.number().min(-90).max(90),
      lng: Joi.number().min(-180).max(180),
    }).optional(),
  }).required(),
  amount: fields.positiveNumber.required(),
  collateralAmount: fields.positiveNumber.required(),
});

const assignRunner = Joi.object({
  runnerId: fields.objectId.required(),
});

const disputeErrand = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required(),
});

const completeErrand = Joi.object({
  proofOfCompletion: Joi.string().trim().max(500).optional(),
});

// ── Dispute schemas ───────────────────────────────────────────────────────────

const raiseDispute = Joi.object({
  reason: Joi.string().trim().min(10).max(500).required(),
  evidence: Joi.array().items(Joi.string().uri()).max(5).optional(),
});

const resolveDispute = Joi.object({
  outcome: Joi.string().valid('customer_refunded', 'runner_paid', 'split').required(),
  notes: Joi.string().trim().max(1000).optional(),
  penaltyAmount: Joi.number().min(0).optional(),
  refundAmount: Joi.number().min(0).optional(),
});

const rejectDispute = Joi.object({
  notes: Joi.string().trim().min(5).max(500).required(),
});

// ── Payment schemas ───────────────────────────────────────────────────────────

const initiatePayment = Joi.object({
  errandId: fields.objectId.required(),
  phone: fields.phone.required(),
});

const initiateWithdrawal = Joi.object({
  amount: fields.positiveNumber.required(),
  phone: fields.phone.required(),
});

// ── Runner schemas ────────────────────────────────────────────────────────────

const rateRunner = Joi.object({
  errandId: fields.objectId.required(),
  stars: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(500).optional(),
});

// ── Profile schemas ───────────────────────────────────────────────────────────

const updatePersonalInfo = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional(),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).optional(),
  dateOfBirth: Joi.date().max('now').optional(),
  gender: Joi.string().valid('female', 'male', 'other').optional(),
}).min(1);

const updateVehicleInfo = Joi.object({
  vehicleInfo: Joi.object({
    type: Joi.string().trim().max(50).allow(null, ''),
    make: Joi.string().trim().max(50).allow(null, ''),
    model: Joi.string().trim().max(50).allow(null, ''),
    year: Joi.string().trim().max(4).allow(null, ''),
    licensePlate: Joi.string().trim().max(20).allow(null, ''),
    color: Joi.string().trim().max(30).allow(null, ''),
    registrationNumber: Joi.string().trim().max(30).allow(null, ''),
  }).required(),
});

const updatePayoutDetails = Joi.object({
  payoutDetails: Joi.object({
    method: Joi.string().valid('mpesa', 'bank').required(),
    mpesaNumber: fields.phone.allow(null, '').optional(),
    bankName: Joi.string().trim().max(100).allow(null, ''),
    bankAccountNumber: Joi.string().trim().max(50).allow(null, ''),
    bankAccountName: Joi.string().trim().max(100).allow(null, ''),
  }).required(),
});

const updatePaymentMethod = Joi.object({
  mpesaNumber: fields.phone.required(),
});

// ── Saved address schemas ─────────────────────────────────────────────────────

const coordinates = Joi.object({
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
});

const createAddress = Joi.object({
  label: Joi.string().trim().min(1).max(50).required(),
  address: Joi.string().trim().min(3).max(300).required(),
  coordinates: coordinates.optional(),
  tag: Joi.string().valid('Home', 'Work', 'Other').default('Other'),
});

const updateAddress = Joi.object({
  label: Joi.string().trim().min(1).max(50).optional(),
  address: Joi.string().trim().min(3).max(300).optional(),
  coordinates: coordinates.optional(),
  tag: Joi.string().valid('Home', 'Work', 'Other').optional(),
  isFavorite: Joi.boolean().optional(),
}).min(1);

// ── Admin schemas ─────────────────────────────────────────────────────────────

const adjustWallet = Joi.object({
  operation: Joi.string().valid('credit', 'debit').required(),
  amount: fields.positiveNumber.required(),
  reason: Joi.string().trim().min(5).max(300).required(),
});

const adminUpdateUser = Joi.object({
  isActive: Joi.boolean().optional(),
  level: Joi.number().integer().min(1).max(5).optional(),
}).min(1).messages({ 'object.min': 'At least one field must be provided' });

const broadcast = Joi.object({
  target: Joi.string().required(),
  event: Joi.string().trim().max(100).required(),
  message: Joi.string().trim().max(1000).required(),
});

// ── Notification schemas ──────────────────────────────────────────────────────

const registerDeviceToken = Joi.object({
  fcmToken: Joi.string().required(),
});

// ── Validation middleware factory ─────────────────────────────────────────────

/**
 * @param {Joi.Schema} schema — the Joi schema to validate against
 * @param {'body'|'query'|'params'} source — which part of req to validate (default: 'body')
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,       // collect all errors
      allowUnknown: false,     // reject unknown keys
      stripUnknown: true,      // remove unknown keys from output
    });

    if (error) {
      const messages = error.details.map((d) => d.message.replace(/['"]/g, ''));
      return res.status(422).json({
        status: 'fail',
        message: 'Validation failed',
        errors: messages,
      });
    }

    // Replace with validated (and stripped) value
    req[source] = value;
    next();
  };
};

// ── Query pagination validator ────────────────────────────────────────────────

const paginationSchema = Joi.object({
  page: fields.pagination.page,
  limit: fields.pagination.limit,
  sortBy: Joi.string().max(50).optional(),
  order: Joi.string().valid('asc', 'desc').optional(),
  dateFrom: Joi.string().isoDate().optional(),
  dateTo: Joi.string().isoDate().optional(),
  period: Joi.string().valid('day', 'week', 'month', 'quarter', 'year').optional(),
}).options({ allowUnknown: true }); // allow domain-specific filters to pass through

const validatePagination = validate(paginationSchema, 'query');

module.exports = {
  validate,
  validatePagination,
  schemas: {
    // Auth
    register,
    login,
    changePassword,
    sendOtp,
    verifyOtp,
    forgotPassword,
    resetPassword,
    googleAuth,
    completePhone,
    // Errands
    createErrand,
    assignRunner,
    disputeErrand,
    completeErrand,
    // Disputes
    raiseDispute,
    resolveDispute,
    rejectDispute,
    // Payments
    initiatePayment,
    initiateWithdrawal,
    // Runner
    rateRunner,
    // Profile
    updatePersonalInfo,
    updateVehicleInfo,
    updatePayoutDetails,
    updatePaymentMethod,
    // Saved addresses
    createAddress,
    updateAddress,
    // Admin
    adjustWallet,
    adminUpdateUser,
    broadcast,
    // Notifications
    registerDeviceToken,
  },
};
