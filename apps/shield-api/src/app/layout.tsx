import type { ReactNode } from "react";

export const metadata = {
  title: "Sahaj Shield Test API",
  description: "Stopgap Shield API for end-to-end device and voice testing.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

