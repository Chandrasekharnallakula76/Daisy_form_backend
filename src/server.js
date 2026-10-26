const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const helmet = require("helmet");

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 4000;
const dataFile = path.resolve(process.env.DATA_FILE || "./data/inquiries.json");
let writeQueue = Promise.resolve();

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "20kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/inquiries", async (request, response, next) => {
  try {
    const inquiry = {
      ...request.body,
      id: crypto.randomUUID(),
      submittedAt: new Date().toISOString(),
    };

    await saveInquiry(inquiry);
    return response.status(201).json({ message: "Inquiry received", inquiry });
  } catch (error) {
    return next(error);
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.use((error, _request, response, _next) => {
  if (error.type === "entity.parse.failed") {
    return response
      .status(400)
      .json({ error: "Request body must be valid JSON" });
  }
  if (error.type === "entity.too.large") {
    return response.status(413).json({ error: "Request body is too large" });
  }

  console.error(error);
  return response.status(500).json({ error: "Unable to process inquiry" });
});

function saveInquiry(inquiry) {
  const save = async () => {
    await fs.mkdir(path.dirname(dataFile), { recursive: true });

    let inquiries = [];
    try {
      inquiries = JSON.parse(await fs.readFile(dataFile, "utf8"));
      if (!Array.isArray(inquiries)) {
        throw new Error("Inquiry data file must contain a JSON array");
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    inquiries.push(inquiry);
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(inquiries, null, 2));
    await fs.rename(temporaryFile, dataFile);
  };

  writeQueue = writeQueue.then(save, save);
  return writeQueue;
}

app.listen(port, (error) => {
  if (error) {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Set a different PORT in .env.`
        : error,
    );
    process.exit(1);
  }
  console.log(`Inquiry API listening on port ${port}`);
});
