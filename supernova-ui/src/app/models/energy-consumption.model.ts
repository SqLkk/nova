export interface EnergyConsumptionData {
  id?: number;
  timestamp: Date | string;
  active_energy: number;  // kWh
  reactive_energy: number; // kVarh
  apparent_energy: number; // kVAh
  demand?: number;  // kW
  period?: string;  // 'daily', 'monthly', 'yearly'
  cost?: number;
}