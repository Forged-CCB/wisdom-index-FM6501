// Manage accounts from the command line.
//   npm run user:add -- you@example.com "Your Name"
//   npm run user:password -- you@example.com
// The password is read from FF_PASSWORD or prompted for.
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { openDb } from "./db.ts";
import { createUser, setPassword } from "./auth.ts";

const [cmd, email, name] = process.argv.slice(2);
if (!cmd || !email) {
  console.log('Usage: user-cli.ts add <email> [name] | password <email>');
  process.exit(1);
}
let pw = process.env.FF_PASSWORD || "";
if (!pw) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  pw = await rl.question("Password (10+ characters): ");
  rl.close();
}
const db = openDb(process.env.FF_DB || resolve("data/forge-and-field.db"));
if (cmd === "add") {
  const u = createUser(db, email, pw, name || "");
  console.log(`Created ${u.email}`);
} else if (cmd === "password") {
  console.log(setPassword(db, email, pw) ? "Password changed; old sessions signed out." : "No account with that email.");
} else {
  console.log("Unknown command");
  process.exit(1);
}
