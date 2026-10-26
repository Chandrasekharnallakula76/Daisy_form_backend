const stringFields = [
  "fullName", "companyOrganization", "businessEmail", "jobTitle", "phoneNumber",
  "interestOther", "questionsOrComments",
];
const interestOptions = new Set([
  "product-demo", "ai-solutions", "business-partnership", "pricing-info", "other",
]);
const followUpOptions = new Set(["email", "phone"]);

class ValidationError extends Error {}

function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const inquiry = {};
  for (const field of stringFields) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string") {
        throw new ValidationError(`${field} must be a string`);
      }
      inquiry[field] = body[field].trim();
    }
  }
  for (const field of ["fullName", "companyOrganization", "businessEmail"]) {
    if (!inquiry[field]) throw new ValidationError(`${field} is required`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.businessEmail)) {
    throw new ValidationError("businessEmail must be a valid email address");
  }
  for (const [field, options] of [
    ["interests", interestOptions], ["preferredFollowUpMethods", followUpOptions],
  ]) {
    const values = body[field] === undefined && field === "preferredFollowUpMethods" ? [] : body[field];
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !options.has(value.trim()))) {
      throw new ValidationError(`${field} must contain supported choices`);
    }
    inquiry[field] = values.map((value) => value.trim());
  }
  if (!inquiry.interests.length) throw new ValidationError("At least one interest is required");
  if (inquiry.interests.includes("other") && !inquiry.interestOther) {
    throw new ValidationError("interestOther is required when selecting other");
  }
  if (inquiry.preferredFollowUpMethods.includes("phone") && !inquiry.phoneNumber) {
    throw new ValidationError("phoneNumber is required for phone follow-up");
  }
  return inquiry;
}

module.exports = { ValidationError, validateSubmission };
