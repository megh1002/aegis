// Runs once when the console starts: print the approval link.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { approverToken } = await import("./lib/approver");
  const port = process.env.PORT ?? "3000";
  console.log(
    `\n  Aegis console\n  To approve actions, open this link in your browser (keep it private):\n  http://localhost:${port}/?token=${approverToken()}\n`,
  );
}
