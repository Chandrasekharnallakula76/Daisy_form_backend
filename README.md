# Daisy Form API

Express backend for the inquiry form.

## Setup

```sh
npm install
```

Copy `.env.example` to `.env` and set `CLIENT_ORIGIN` to the URL serving the form. Start the API with:

```sh
npm run dev
```

The API listens on port `4000` by default. Inquiry records are stored in `data/inquiries.json`.

## Endpoints

- `GET /api/health` checks that the API is running.
- `POST /api/inquiries` validates and stores an inquiry.

Example request:

```json
{
  "fullName": "Taylor Example",
  "companyOrganization": "Example Company",
  "businessEmail": "taylor@example.com",
  "jobTitle": "Product Manager",
  "phoneNumber": "+1 555 0100",
  "interests": ["product-demo", "other"],
  "interestOther": "Integration details",
  "preferredFollowUpMethods": ["email"],
  "questionsOrComments": "Please contact me next week."
}
```

Interest values are `product-demo`, `exploring-ai`, `business-partnership`, `pricing-info`, and `other`. Follow-up methods are `email` and `phone`. Optional text fields may be empty, and at least one interest is required. Validation errors return status `400`; a saved inquiry returns status `201`.
