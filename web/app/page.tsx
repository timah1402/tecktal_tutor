import { redirect } from "next/navigation";

// No standalone root page exists anymore — the app's home lives at /home
// (this used to be a full page here before that move). Several links
// (the sidebar logo, the profile/admin "back" links) still point at "/",
// so redirect rather than leaving it a 404.
export default function RootPage() {
  redirect("/home");
}
