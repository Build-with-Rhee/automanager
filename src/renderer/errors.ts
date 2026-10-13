export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method (?:'[^']+'|"[^"]+"): (?:Error: )?/,
    "",
  );
}
