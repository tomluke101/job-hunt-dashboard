import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import Sidebar from "./_components/Sidebar";

export const metadata: Metadata = {
  title: "Job Hunt Dashboard",
  description: "Your personal job hunting command centre",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className="h-full">
        <body className="h-full flex">
          <Sidebar />
          <main className="flex-1 overflow-y-auto min-h-screen">
            {children}
          </main>
        </body>
      </html>
    </ClerkProvider>
  );
}
