@editor @continuity
Feature: Writing across scene boundaries
  As a writer
  I want the manuscript to behave as one continuous text
  So that scene boundaries never get in the way of writing

  Background:
    Given a project with a root manuscript named "Manuscript"

  Rule: Prose either side of a scene

    Background:
      Given "Manuscript" contains the following content in order:
        | kind  | title  | text                    |
        | prose |        | "The door opened. "     |
        | scene | Inside | "A figure stood there." |
        | prose |        | " Then silence."        |
      And I open "Manuscript" in the editor

    Scenario: The arrow keys step into a scene, one boundary per key press
      Given I place the caret between "opened" and ". "
      When I press "ArrowRight" 3 times
      And I type "Slowly, "
      Then "Inside" should own the prose "Slowly, A figure stood there."

    Scenario: The arrow keys step out of a scene, one boundary per key press
      Given I place the caret between "stood there" and "."
      When I press "ArrowRight" 2 times
      And I type " Nothing moved."
      Then "Manuscript" should own the prose " Nothing moved. Then silence."
      And "Inside" should own the prose "A figure stood there."

    Scenario: Copying a selection that crosses a boundary copies just the prose
      Given I select from the text "opened." to the text "stood"
      When I copy the selection
      Then the clipboard should contain "opened. A figure stood"

    # Today's behaviour, written down to confirm or change: what's typed goes where the selection started, the
    # selected text on both sides goes, and the scene stays.
    Scenario: Typing over a selection that runs into a scene keeps the scene
      Given I select from the text "opened." to the text "A figure"
      When I type "closed. "
      Then "Manuscript" should own the prose "The door closed. "
      And "Inside" should own the prose " stood there."
      And "Inside" should be a child of "Manuscript"

  Rule: A chapter that opens and closes with a scene

    Background:
      Given "Manuscript" contains a child scene "Chapter One"
      And "Chapter One" contains a child scene "Arrival"
      And "Arrival" contains the prose "She arrived."
      And I open "Manuscript" in the editor

    Scenario: Typing at the very start of the chapter belongs to the chapter
      Given I place the caret at the start of "Chapter One" on the child side
      When I type "Chapter one. "
      Then "Chapter One" should own the prose "Chapter one. "

    Scenario: Typing at the very end of the chapter belongs to the chapter
      Given I place the caret at the end of "Chapter One" on the child side
      When I type " The end."
      Then "Chapter One" should own the prose " The end."
