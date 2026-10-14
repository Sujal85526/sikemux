import { lazy, Suspense } from "react";
import type { PluginTopBarProps } from "../../plugin-api";
import { registerFrontendPlugin, signInOf } from "../../plugin-api";
import { useResource } from "../../plugin-api/resources";
import { jiraStatusR } from "./resources";
import { JiraMark } from "./components/JiraMark";
import { JIRA_ISSUES, JIRA_PLUGIN_ID } from "./kinds";
import { openJira } from "./state";

const JiraPane = lazy(() => import("./components/JiraPane").then((module) => ({ default: module.JiraPane })));
const JiraTopBarItem = lazy(() => import("./components/JiraTopBarItem").then((module) => ({ default: module.JiraTopBarItem })));

function JiraTopBar(props: PluginTopBarProps) {
    return (
        <Suspense fallback={null}>
            <JiraTopBarItem {...props} />
        </Suspense>
    );
}

registerFrontendPlugin({
    id: JIRA_PLUGIN_ID,
    surfaces: [
        {
            kind: JIRA_ISSUES,
            title: "Jira",
            icon: (size) => <JiraMark size={size} />,
            render: ({ paneId, visible }) => <JiraPane paneId={paneId} active={visible} />,
        },
    ],
    open: openJira,
    openTitle: "Open Jira",
    mark: (size) => <JiraMark size={size} />,
    linkHosts: [".atlassian.net"],
    TopBarItem: JiraTopBar,
    useSignIn: function useServiceSignIn() {
        return signInOf(useResource(jiraStatusR));
    },
});
