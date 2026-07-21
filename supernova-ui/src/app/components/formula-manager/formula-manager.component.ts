import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CHART_PALETTE } from '../../shared/theme/palette';

export interface FormulaDefinition {
  id: string;
  enabled: boolean;
  name: string;
  expression: string;
  type: 'arithmetic' | 'aggregation' | 'conditional' | 'statistical';
  outputColumn: string;
  description: string;
  referencedPaths: number[];
  color: string;
  format: {
    decimals: number;
    unit: string;
    prefix: string;
    suffix: string;
  };
}

export interface FormulaPath {
  index: number;
  path: string;
  label: string;
  isRt: boolean;
  color: string;
  sourceTag: string;
}

@Component({
  standalone: false,
  selector: 'app-formula-manager',
  templateUrl: './formula-manager.component.html',
  styleUrls: ['./formula-manager.component.scss']
})
export class FormulaManagerComponent implements OnInit, OnChanges {
  @Input() selectedPaths: string[] = [];
  @Input() isVisible: boolean = false;
  @Input() existingFormulas: FormulaDefinition[] = [];
  @Output() formulasUpdated = new EventEmitter<FormulaDefinition[]>();
  @Output() closeManager = new EventEmitter<void>();

  formulas: FormulaDefinition[] = [];
  formulaPaths: FormulaPath[] = [];
  
  // UI state
  editingFormulaId: string | null = null;
  expressionCursorPos: number = 0;
  validationErrors: { [id: string]: string } = {};
  showFunctionRef: boolean = false;

  // Color presets (merkezi kategorik paletten beslenir)
  colorPresets = [...CHART_PALETTE];

  // Available functions grouped by category
  functionCategories = [
    {
      name: 'FORMULA.CAT_ARITHMETIC',
      icon: 'fa-calculator',
      functions: [
        { name: 'ABS', syntax: 'ABS(x)', desc: 'FORMULA.FN_ABS' },
        { name: 'ROUND', syntax: 'ROUND(x, decimals)', desc: 'FORMULA.FN_ROUND' },
        { name: 'CEIL', syntax: 'CEIL(x)', desc: 'FORMULA.FN_CEIL' },
        { name: 'FLOOR', syntax: 'FLOOR(x)', desc: 'FORMULA.FN_FLOOR' },
        { name: 'MOD', syntax: 'MOD(x, y)', desc: 'FORMULA.FN_MOD' },
        { name: 'POWER', syntax: 'POWER(x, n)', desc: 'FORMULA.FN_POWER' },
        { name: 'SQRT', syntax: 'SQRT(x)', desc: 'FORMULA.FN_SQRT' },
      ]
    },
    {
      name: 'FORMULA.CAT_AGGREGATION',
      icon: 'fa-layer-group',
      functions: [
        { name: 'SUM', syntax: 'SUM(P1, P2, ...)', desc: 'FORMULA.FN_SUM' },
        { name: 'AVG', syntax: 'AVG(P1, P2, ...)', desc: 'FORMULA.FN_AVG' },
        { name: 'MIN', syntax: 'MIN(P1, P2, ...)', desc: 'FORMULA.FN_MIN' },
        { name: 'MAX', syntax: 'MAX(P1, P2, ...)', desc: 'FORMULA.FN_MAX' },
        { name: 'COUNT', syntax: 'COUNT(P1)', desc: 'FORMULA.FN_COUNT' },
      ]
    },
    {
      name: 'FORMULA.CAT_STATISTICAL',
      icon: 'fa-chart-bar',
      functions: [
        { name: 'STDEV', syntax: 'STDEV(P1)', desc: 'FORMULA.FN_STDEV' },
        { name: 'VARIANCE', syntax: 'VARIANCE(P1)', desc: 'FORMULA.FN_VARIANCE' },
        { name: 'MEDIAN', syntax: 'MEDIAN(P1)', desc: 'FORMULA.FN_MEDIAN' },
        { name: 'PERCENTILE', syntax: 'PERCENTILE(P1, 95)', desc: 'FORMULA.FN_PERCENTILE' },
        { name: 'DELTA', syntax: 'DELTA(P1)', desc: 'FORMULA.FN_DELTA' },
        { name: 'RATE', syntax: 'RATE(P1)', desc: 'FORMULA.FN_RATE' },
      ]
    },
    {
      name: 'FORMULA.CAT_CONDITIONAL',
      icon: 'fa-code-branch',
      functions: [
        { name: 'IF', syntax: 'IF(condition, true_val, false_val)', desc: 'FORMULA.FN_IF' },
        { name: 'CLAMP', syntax: 'CLAMP(x, min, max)', desc: 'FORMULA.FN_CLAMP' },
        { name: 'COALESCE', syntax: 'COALESCE(P1, P2)', desc: 'FORMULA.FN_COALESCE' },
      ]
    }
  ];

  // Operators
  operators = [
    { symbol: '+', label: '+', desc: 'Add' },
    { symbol: '-', label: '-', desc: 'Subtract' },
    { symbol: '*', label: '×', desc: 'Multiply' },
    { symbol: '/', label: '÷', desc: 'Divide' },
    { symbol: '(', label: '(', desc: 'Open' },
    { symbol: ')', label: ')', desc: 'Close' },
    { symbol: '>', label: '>', desc: 'Greater' },
    { symbol: '<', label: '<', desc: 'Less' },
    { symbol: '==', label: '==', desc: 'Equal' },
    { symbol: '!=', label: '!=', desc: 'Not Equal' },
  ];

  formulaTypes = [
    { value: 'arithmetic', labelKey: 'FORMULA.TYPE_ARITHMETIC', icon: 'fa-calculator', color: 'amber' },
    { value: 'aggregation', labelKey: 'FORMULA.TYPE_AGGREGATION', icon: 'fa-layer-group', color: 'blue' },
    { value: 'statistical', labelKey: 'FORMULA.TYPE_STATISTICAL', icon: 'fa-chart-bar', color: 'purple' },
    { value: 'conditional', labelKey: 'FORMULA.TYPE_CONDITIONAL', icon: 'fa-code-branch', color: 'emerald' },
  ];

  constructor(private translate: TranslateService) {}

  ngOnInit(): void {
    this.buildPathList();
    if (this.existingFormulas?.length) {
      this.formulas = JSON.parse(JSON.stringify(this.existingFormulas));
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selectedPaths']) {
      this.buildPathList();
    }
  }

  private buildPathList(): void {
    const pathColors = [...CHART_PALETTE];
    this.formulaPaths = this.selectedPaths.map((path, i) => {
      // Path is now the full label with source prefix (e.g. "SYS Aggregated – vienna / 110 / MvMoment")
      const isRt = path.startsWith('LIVE');
      const sourceTag = path.includes(' – ') ? path.split(' – ')[0] : '';
      return {
        index: i,
        path,
        label: path,
        isRt,
        color: pathColors[i % pathColors.length],
        sourceTag
      };
    });
  }

  private generateId(): string {
    return 'f_' + Math.random().toString(36).substring(2, 9);
  }

  addNewFormula(): void {
    const newFormula: FormulaDefinition = {
      id: this.generateId(),
      enabled: true,
      name: `${this.translate.instant('FORMULA.FORMULA')} ${this.formulas.length + 1}`,
      expression: '',
      type: 'arithmetic',
      outputColumn: `Formula_${this.formulas.length + 1}`,
      description: '',
      referencedPaths: [],
      color: this.colorPresets[this.formulas.length % this.colorPresets.length],
      format: {
        decimals: 2,
        unit: '',
        prefix: '',
        suffix: ''
      }
    };
    this.formulas.push(newFormula);
    this.editingFormulaId = newFormula.id;
  }

  removeFormula(index: number): void {
    const id = this.formulas[index].id;
    this.formulas.splice(index, 1);
    if (this.editingFormulaId === id) {
      this.editingFormulaId = null;
    }
    delete this.validationErrors[id];
    this.emitUpdate();
  }

  duplicateFormula(index: number): void {
    const original = this.formulas[index];
    const copy: FormulaDefinition = {
      ...JSON.parse(JSON.stringify(original)),
      id: this.generateId(),
      name: `${original.name} (copy)`,
      outputColumn: `${original.outputColumn}_copy`
    };
    this.formulas.splice(index + 1, 0, copy);
    this.editingFormulaId = copy.id;
  }

  toggleFormula(formula: FormulaDefinition): void {
    formula.enabled = !formula.enabled;
    this.emitUpdate();
  }

  insertPathReference(formula: FormulaDefinition, pathIndex: number): void {
    const ref = `P${pathIndex + 1}`;
    formula.expression += (formula.expression && !formula.expression.endsWith('(') && !formula.expression.endsWith(' ') ? ' ' : '') + ref;
    if (!formula.referencedPaths.includes(pathIndex)) {
      formula.referencedPaths.push(pathIndex);
    }
    this.validateFormula(formula);
  }

  insertOperator(formula: FormulaDefinition, op: string): void {
    const needsSpace = op.length > 1 || ['+', '-', '*', '/', '>', '<'].includes(op);
    if (needsSpace) {
      formula.expression += ` ${op} `;
    } else {
      formula.expression += op;
    }
    this.validateFormula(formula);
  }

  insertFunction(formula: FormulaDefinition, fn: { name: string; syntax: string }): void {
    formula.expression += (formula.expression && !formula.expression.endsWith(' ') ? ' ' : '') + fn.name + '(';
    this.validateFormula(formula);
  }

  insertConstant(formula: FormulaDefinition, value: string): void {
    formula.expression += value;
    this.validateFormula(formula);
  }

  clearExpression(formula: FormulaDefinition): void {
    formula.expression = '';
    formula.referencedPaths = [];
    this.validateFormula(formula);
  }

  validateFormula(formula: FormulaDefinition): void {
    const expr = formula.expression.trim();
    if (!expr) {
      this.validationErrors[formula.id] = this.translate.instant('FORMULA.ERR_EMPTY');
      return;
    }

    // Check balanced parentheses
    let depth = 0;
    for (const ch of expr) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) {
        this.validationErrors[formula.id] = this.translate.instant('FORMULA.ERR_PARENS');
        return;
      }
    }
    if (depth !== 0) {
      this.validationErrors[formula.id] = this.translate.instant('FORMULA.ERR_PARENS');
      return;
    }

    // Check path references exist
    const pathRefs = expr.match(/P(\d+)/g) || [];
    for (const ref of pathRefs) {
      const idx = parseInt(ref.substring(1), 10) - 1;
      if (idx < 0 || idx >= this.selectedPaths.length) {
        this.validationErrors[formula.id] = this.translate.instant('FORMULA.ERR_INVALID_PATH', { ref });
        return;
      }
    }

    // Update referenced paths
    formula.referencedPaths = [...new Set(pathRefs.map(r => parseInt(r.substring(1), 10) - 1))];

    delete this.validationErrors[formula.id];
  }

  isValid(formula: FormulaDefinition): boolean {
    return !this.validationErrors[formula.id] && formula.expression.trim().length > 0;
  }

  getFormulaTypeInfo(type: string): any {
    return this.formulaTypes.find(t => t.value === type) || this.formulaTypes[0];
  }

  getEnabledCount(): number {
    return this.formulas.filter(f => f.enabled).length;
  }

  getEditingFormula(): FormulaDefinition | null {
    return this.formulas.find(f => f.id === this.editingFormulaId) || null;
  }

  getExpressionPreview(formula: FormulaDefinition): string {
    let preview = formula.expression;
    // Replace P1, P2 etc with short path labels
    for (const fp of this.formulaPaths) {
      const ref = `P${fp.index + 1}`;
      preview = preview.replace(new RegExp(`\\b${ref}\\b`, 'g'), `[${fp.label}]`);
    }
    return preview;
  }

  moveFormula(index: number, direction: 'up' | 'down'): void {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= this.formulas.length) return;
    const temp = this.formulas[index];
    this.formulas[index] = this.formulas[newIndex];
    this.formulas[newIndex] = temp;
  }

  onExpressionInput(formula: FormulaDefinition): void {
    this.validateFormula(formula);
  }

  emitUpdate(): void {
    this.formulasUpdated.emit(this.formulas.filter(f => f.enabled && this.isValid(f)));
  }

  saveAndClose(): void {
    // Validate all formulas
    for (const formula of this.formulas) {
      this.validateFormula(formula);
    }
    this.emitUpdate();
    this.closeManager.emit();
  }

  close(): void {
    this.closeManager.emit();
  }
}
