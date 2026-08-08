// Leak-scan fixture (ENV_APP=src/LeakApp.tsx): the literal value of
// SESSION_SECRET from .env, hand-inlined into client code — no
// virtual:env/server import anywhere, so only the generateBundle scan can
// catch it. The scan matches *quoted* string literals of server values in
// client chunks (the prior-art heuristic — precise, no false positives on
// substrings), so the fixture keeps the literal in a quoted position
// rather than JSX text, which would compile into a template string.
const leaked = 'test-session-secret-0123456789abcdef';

export default function LeakApp() {
  console.log('boot', leaked);
  return <p id="marker">leaky</p>;
}
