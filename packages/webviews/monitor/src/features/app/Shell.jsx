// @ts-check

/**
 * @typedef {Object} ShellProps
 * @property {import('react').ReactNode} [header] - The content to display in
 *   the header area.
 * @property {import('react').ReactNode} [body] - The content to display in the
 *   body area.
 * @property {import('react').ReactNode} [footer] - The content to display in
 *   the footer area.
 */

/** @param {ShellProps} props */
export default function Shell({ header, body, footer }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {header && <div style={{ padding: 8 }}>{header}</div>}
      {body && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {body}
        </div>
      )}
      {footer && <div style={{ padding: 8 }}>{footer}</div>}
    </div>
  )
}
