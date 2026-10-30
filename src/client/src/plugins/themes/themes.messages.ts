import { message } from "../../localization/service";

export default {
  darkName: message("PI WEB Dark", "Built-in dark theme display name; preserve PI WEB branding"),
  darkDescription: message("Dark PI WEB palette.", "Built-in dark theme description"),
  lightName: message("PI WEB Light", "Built-in light theme display name; preserve PI WEB branding"),
  lightDescription: message("Light PI WEB palette.", "Built-in light theme description"),
  classicName: message("PI WEB Classic", "Original theme display name; preserve PI WEB branding"),
  classicDescription: message("The original PI WEB dark palette.", "Original theme description"),
  paperName: message("Paper", "Built-in neutral light theme display name"),
  paperDescription: message("White and neutral grays with restrained status colors.", "Neutral light theme description"),
  graphiteName: message("Graphite", "Built-in neutral dark theme display name"),
  graphiteDescription: message("Charcoal and neutral grays with restrained status colors.", "Neutral dark theme description"),
  piWebPairName: message("PI WEB", "Built-in light/dark theme pair display name; preserve branding"),
  piWebPairDescription: message("Follow the system light/dark preference with PI WEB themes.", "Built-in light/dark theme pair description"),
  neutralPairName: message("Paper / Graphite", "Neutral light/dark theme pair display name; use the translated theme names"),
  neutralPairDescription: message("Follow the system light/dark preference with neutral gray themes.", "Neutral light/dark theme pair description"),
  materialName: message("Material", "Material file icon theme display name; preserve upstream branding"),
  materialDescription: message("Material icons for files, bundled for offline use.", "Built-in Material file icon theme description"),
};
