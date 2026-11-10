import { message } from "../localization/service";

export default {
  movedBefore: message<{ name: string; neighbor: string }>("Moved {name} before {neighbor}.", "Live announcement of a requested navigation reorder; not a save confirmation"),
  movedAfter: message<{ name: string; neighbor: string }>("Moved {name} after {neighbor}.", "Live announcement of a requested navigation reorder; not a save confirmation"),
};
