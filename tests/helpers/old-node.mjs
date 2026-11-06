// Preload that makes this process report another Node version (QA_FAKE_NODE), to exercise the
// guard in tools/eval.mjs.
if (process.env.QA_FAKE_NODE) Object.defineProperty(process.versions, 'node', { value: process.env.QA_FAKE_NODE, configurable: true });
