// Load only environment variables (sensitive values live in .env)
require('dotenv').config();
const path = require('path');

// Default values for runtime configuration. Keep non-sensitive defaults here
const DEFAULTS = {
  SEARCH_URL:
    'https://www.boligportal.dk/lejligheder/k%C3%B8benhavn/1-2-v%C3%A6relser/?max_monthly_rent=13000&min_rental_period=0',
  POLL_MS: 10 * 1000,
  INITIAL_COUNT: 50,
  SEEN_FILE: path.join(__dirname, 'seen.json'),
  SUBSCRIBERS_FILE: path.join(__dirname, 'subscribers.json'),
  SMTP_HOST: 'smtp-relay.brevo.com',
  SMTP_PORT: 587,
  SMTP_USER: 'a7dc68001@smtp-brevo.com',
  SMTP_PASS: 'xsmtpsib-7115b9929bc2d185a7f1f5f63cfbb7232659bda1610416fa0779c8445519ceb9-gzgBIW0Cu3eC07Pr',
  SENDER: 'Boligportal Monitor <benceg666g@gmail.com>',
  PORT: 3000,
};

const env = process.env;

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = Object.freeze({
  SEARCH_URL: env.SEARCH_URL || DEFAULTS.SEARCH_URL,
  POLL_MS: toNumber(env.POLL_MS, DEFAULTS.POLL_MS),
  INITIAL_COUNT: toNumber(env.INITIAL_COUNT, DEFAULTS.INITIAL_COUNT),
  SEEN_FILE: env.SEEN_FILE || DEFAULTS.SEEN_FILE,
  SUBSCRIBERS_FILE: env.SUBSCRIBERS_FILE || DEFAULTS.SUBSCRIBERS_FILE,
  SMTP_HOST: env.SMTP_HOST || DEFAULTS.SMTP_HOST,
  SMTP_PORT: toNumber(env.SMTP_PORT, DEFAULTS.SMTP_PORT),
  SMTP_USER: (env.SMTP_USER || DEFAULTS.SMTP_USER).trim(),
  SMTP_PASS: (env.SMTP_PASS || DEFAULTS.SMTP_PASS).trim(),
  SENDER: env.SENDER || DEFAULTS.SENDER,
  PORT: toNumber(env.PORT, DEFAULTS.PORT),
});
