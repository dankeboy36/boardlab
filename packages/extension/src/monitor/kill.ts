export async function kill(pid: number, force = false): Promise<void> {
  const { default: fkill } = await import('fkill')
  await fkill(pid, { force })
}
