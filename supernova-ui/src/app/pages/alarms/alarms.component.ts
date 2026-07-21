import { Component, OnInit } from '@angular/core';

@Component({
  standalone: false,
  selector: 'app-alarms',
  templateUrl: './alarms.component.html',
  styleUrls: ['./alarms.component.scss']
})
export class AlarmsComponent implements OnInit {
  constructor() {}

  ngOnInit(): void {
    // Alarms module dummied out for generic implementation
  }
}
