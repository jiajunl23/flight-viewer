import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flight Viewer",
  description: "Real-time worldwide flight tracker on a 3D globe",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-black text-zinc-100">
        {children}
      </body>
    </html>
  );
}
