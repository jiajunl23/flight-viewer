import type { Metadata } from "next";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "North America Flight Tracker",
  description:
    "Real-time flight tracker covering North American airspace on a 3D globe",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-black text-zinc-100">
        <ClerkProvider>
          <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-black/70 backdrop-blur">
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-lg">✈</span>
              <span className="font-semibold tracking-tight">
                North America Flight Tracker
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal" />
                <SignUpButton mode="modal" />
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
