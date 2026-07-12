import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, docsRoute, gitConfig } from "./shared";

function Brand() {
  return (
    <>
      {/* Static public SVGs; next/image is unnecessary for small logos */}
      {/* oxlint-disable-next-line next/no-img-element */}
      <img
        src="/logo.svg"
        alt=""
        width={24}
        height={24}
        className="size-6 dark:hidden"
      />
      {/* oxlint-disable-next-line next/no-img-element */}
      <img
        src="/logo-dark.svg"
        alt=""
        width={24}
        height={24}
        className="hidden size-6 dark:block"
      />
      <span className="font-semibold tracking-tight">{appName}</span>
    </>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Brand />,
      url: "/",
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        text: "Docs",
        url: docsRoute,
        active: "nested-url",
      },
    ],
    themeSwitch: {
      mode: "light-dark",
    },
  };
}
