export function createSshTerminalDecoder(charset: 'gbk'): (bytes: Uint8Array) => string {
  const decoder = new TextDecoder(charset)
  return (bytes) => decoder.decode(bytes, { stream: true })
}
