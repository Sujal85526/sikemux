import type { ProjectBoard } from "../../agents/agentBoard";
import { mutate } from "../store";
import { ensureRoleWindow } from "./shared";

export const openBoard = (): void => ensureRoleWindow("board", "board", "Board");

/** Takes the boards the core sent, which replace the app's copies of those projects. */
export function setAgentBoards(boards: readonly ProjectBoard[]): void {
    mutate((d) => {
        for (const board of boards) d.agentBoards[board.project] = board.cards;
    });
}

/** Takes one project's board, read or changed for the project open at `folder`. */
export function setAgentBoard(folder: string, board: ProjectBoard): void {
    mutate((d) => {
        d.agentBoards[board.project] = board.cards;
        if (board.project !== folder) d.boardProjects[folder] = board.project;
    });
}
