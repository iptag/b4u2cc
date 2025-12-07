export function randomTriggerSignal(): string {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `<<CALL_${hex}>>`;
}
