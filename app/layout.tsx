import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Kira — join group',
  description: 'Track and split expenses on Kira.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  )
}
