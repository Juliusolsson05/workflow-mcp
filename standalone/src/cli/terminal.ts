/**
 * Render protocol, workflow, and provider text as inert terminal content.
 *
 * WHY: these strings cross a trust boundary even when they came from a local project. ESC/CSI/OSC,
 * carriage return, bidi format controls, and C1 controls can rewrite prior output, set a terminal
 * title, or make a reviewed workflow name visually differ from the bytes that will execute. JSON
 * output deliberately remains byte-faithful; only human terminal surfaces use this projection.
 */
export function terminalSafe(value: unknown, options: { multiline?: boolean } = {}): string {
  const normalized = String(value).replace(/\r\n?/g, '\n')
  const controls = options.multiline === true
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu
    : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu
  return normalized.replace(controls, '\uFFFD')
}
