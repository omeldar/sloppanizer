import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardProvider } from "../keyboard/KeyboardProvider.tsx";
import { setFormatPrefs } from "../lib/format.ts";
import { DateInput, TimeInput } from "./DateTimeInputs.tsx";

afterEach(() => setFormatPrefs({ dateFormat: "dmy.", timeFormat: "24h" }));

describe("DateInput", () => {
  it("shows and reads the account's format", () => {
    const onChange = vi.fn<(value: string) => void>();
    const { rerender } = render(<DateInput aria-label="Due" value="2001-09-11" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Due" }) as HTMLInputElement;
    expect(input.value).toBe("11.09.2001");
    fireEvent.change(input, { target: { value: "12.10.2001" } });
    expect(onChange).toHaveBeenLastCalledWith("2001-10-12");
    fireEvent.blur(input);

    setFormatPrefs({ dateFormat: "mdy/", timeFormat: "12h" });
    rerender(<DateInput aria-label="Due" value="2001-09-11" onChange={onChange} />);
    expect(input.value).toBe("09/11/2001");
  });

  it("starts the calendar on Monday", () => {
    render(
      <KeyboardProvider>
        <DateInput aria-label="Due" value="2026-11-23" onChange={() => {}} />
      </KeyboardProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /calendar/ }));
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers[0]).toBe("Mo");
    expect(headers[6]).toBe("Su");
  });
});

describe("TimeInput", () => {
  it("takes 24h and 12h input and shows the account's format", () => {
    const onChange = vi.fn<(value: string) => void>();
    const { rerender } = render(<TimeInput aria-label="From" value="15:00" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "From" }) as HTMLInputElement;
    expect(input.value).toBe("15:00");
    fireEvent.change(input, { target: { value: "3:30 pm" } });
    expect(onChange).toHaveBeenLastCalledWith("15:30");
    fireEvent.change(input, { target: { value: "0945" } });
    expect(onChange).toHaveBeenLastCalledWith("09:45");
    fireEvent.blur(input);

    setFormatPrefs({ dateFormat: "dmy.", timeFormat: "12h" });
    rerender(<TimeInput aria-label="Other" value="15:00" onChange={onChange} />);
    expect((screen.getByRole("textbox", { name: "Other" }) as HTMLInputElement).value).toBe("3:00 PM");
  });
});
