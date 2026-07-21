// Escapes regex metacharacters so user-supplied strings can be safely
// embedded in a RegExp/$regexMatch without being interpreted as a pattern.
exports.escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
