import { env } from 'virtual:env/server';

// Guard fixture (ENV_APP=src/BadApp.tsx): the app root is part of the
// client module graph (it hydrates), so this import must fail the client
// build with the server-only error naming this file — the exact leak the
// virtual-module split exists to prevent.
export default function BadApp() {
  return <p>{env.SESSION_SECRET}</p>;
}
