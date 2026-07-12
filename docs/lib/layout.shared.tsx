import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, docsRoute, gitConfig } from "./shared";

function Brand() {
  return (
    <>
      <img
        src="/logo.svg"
        alt=""
        width={24}
        height={24}
        className="size-6 dark:hidden"
      />
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
