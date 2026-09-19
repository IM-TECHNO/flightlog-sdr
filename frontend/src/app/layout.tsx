import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlightLog SDR",
  description: "Log, replay and explore ADS-B flights from your SDR in 3D",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
