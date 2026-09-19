import { redirect } from "next/navigation";

/** Old path; the entry is now "Launch" at /launch. */
export default function CreateRedirect() {
  redirect("/launch");
}
