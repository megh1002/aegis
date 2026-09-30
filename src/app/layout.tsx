import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "Aegis sits between an AI agent and its tools. Safe actions run on their own, risky ones wait for a person, and trust is earned over time. Try the one-minute demo.";

export const metadata: Metadata = {
  // Absolute links for the preview image when the site is shared.
  metadataBase: new URL("https://loop-chi-plum.vercel.app"),
  title: "Aegis · A safety checkpoint for AI agents",
  description,
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Aegis",
    title: "Aegis · A safety checkpoint for AI agents",
    description,
  },
  twitter: { card: "summary_large_image", title: "Aegis · A safety checkpoint for AI agents", description },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#06070c] text-neutral-200">
        {children}
      </body>
    </html>
  );
}
