const { stringify } = require("csv-stringify/sync");

const csvColumns = [
  "id", "submittedAt", "fullName", "companyOrganization", "businessEmail",
  "jobTitle", "phoneNumber", "interests", "interestOther",
  "preferredFollowUpMethods", "questionsOrComments",
];

function inquiriesToCsv(inquiries) {
  const records = inquiries.map((inquiry) => Object.fromEntries(
    csvColumns.map((field) => [field, Array.isArray(inquiry[field]) ? inquiry[field].join(";") : inquiry[field] ?? ""]),
  ));
  return stringify(records, {
    columns: csvColumns,
    header: true,
    bom: true,
    escape_formulas: true,
  });
}

module.exports = { csvColumns, inquiriesToCsv };
