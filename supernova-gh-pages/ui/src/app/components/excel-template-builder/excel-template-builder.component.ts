import { Component, OnInit } from '@angular/core';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';

export interface ReportElement {
  id: string;
  type: 'header' | 'table' | 'chart' | 'text';
  content: string;
}

@Component({
  selector: 'app-excel-template-builder',
  templateUrl: './excel-template-builder.component.html',
  styleUrls: ['./excel-template-builder.component.scss'],
  standalone: false
})
export class ExcelTemplateBuilderComponent implements OnInit {
  availableElements: ReportElement[] = [
    { id: 'e1', type: 'header', content: 'Report Title' },
    { id: 'e2', type: 'table', content: 'Data Grid View' },
    { id: 'e3', type: 'chart', content: 'Trend Chart' },
    { id: 'e4', type: 'text', content: 'Summary Notes' },
  ];

  templateElements: ReportElement[] = [];

  constructor() { }

  ngOnInit(): void {
  }

  drop(event: CdkDragDrop<ReportElement[]>) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      // Clone element from available to template
      const element = event.previousContainer.data[event.previousIndex];
      const clone = { ...element, id: `e_${Date.now()}` };
      this.templateElements.splice(event.currentIndex, 0, clone);
    }
  }

  removeElement(index: number) {
    this.templateElements.splice(index, 1);
  }
}
