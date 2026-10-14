import type { Metadata } from "next";
import { Fraunces, Source_Sans_3 } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display-loaded",
});

const body = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-body-loaded",
});

export const metadata: Metadata = {
  title: "Demand Desk — market demand analyst",
  description:
    "Local market demand briefing, analytics, portable memory, and grounded chat for product analysts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${display.variable} ${body.variable}`}
        style={
          {
            ["--font-display" as string]: "var(--font-display-loaded), Georgia, serif",
            ["--font-body" as string]: "var(--font-body-loaded), system-ui, sans-serif",
          } as React.CSSProperties
        }
      >
        {children}
      </body>
    </html>
  );
}
