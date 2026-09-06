import type { SectionDocs } from "../contract/docs.js";

export const docs: SectionDocs = {
  readme: {
    endpoints: "POST/PUT/DELETE pages",
    notes:
      "`build_type: workflow` or `legacy` + source, `cname`, `https_enforced`, `public` (GHEC site visibility); `pages: null` disables the site",
  },
  coverage: [
    {
      area: "[GitHub Pages](https://docs.github.com/en/rest/pages/pages) (build_type, source, cname, https_enforced and any PUT field GitHub adds; pages: null disables the site)",
      notes:
        "POST /repos/{owner}/{repo}/pages (create accepts only build_type/source) then PUT for " +
        "the rest; existing sites get straight PUT passthrough; pages: null issues DELETE, " +
        "mirroring branches' protection: null. In multi-repo mode, pages: null in a target is " +
        "a defaults opt-out instead when the defaults file declares a non-null pages value. " +
        "The Enterprise Cloud site-visibility boolean `public` (public vs repo-members-only) " +
        "rides the PUT passthrough too - the dotcom docs omit it but the GHEC flavor documents " +
        "it, and the GET echoes it in both, so declaring it applies and check-verifies today.",
    },
  ],
};
