"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventType = void 0;
var EventType;
(function (EventType) {
    EventType["TASK_SUBMITTED"] = "TASK_SUBMITTED";
    EventType["PLANNER_SELECTED"] = "PLANNER_SELECTED";
    EventType["DAG_READY"] = "DAG_READY";
    EventType["SUBTASK_CLAIMED"] = "SUBTASK_CLAIMED";
    EventType["SUBTASK_DONE"] = "SUBTASK_DONE";
    EventType["CHALLENGE"] = "CHALLENGE";
    EventType["SLASH_EXECUTED"] = "SLASH_EXECUTED";
    EventType["TASK_REOPENED"] = "TASK_REOPENED";
    EventType["DAG_COMPLETED"] = "DAG_COMPLETED";
    EventType["TASK_FINALIZED"] = "TASK_FINALIZED";
})(EventType || (exports.EventType = EventType = {}));
