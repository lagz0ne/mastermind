import * as SheetPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
	return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
	return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
	className,
	children,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content>) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Overlay
				data-slot="sheet-overlay"
				className="fixed inset-0 z-50 bg-black/20"
			/>
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col gap-3 overflow-y-auto border-l bg-background p-3 sm:max-w-md",
					className,
				)}
				{...props}
			>
				{children}
				<SheetPrimitive.Close className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-sm text-lg text-muted-foreground leading-none hover:bg-accent hover:text-foreground focus-visible:outline-2 max-sm:size-8">
					<span aria-hidden>×</span>
					<span className="sr-only">Close</span>
				</SheetPrimitive.Close>
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sheet-header"
			className={cn("flex flex-col gap-0.5 pr-8", className)}
			{...props}
		/>
	);
}

function SheetTitle({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn("font-bold text-base leading-tight", className)}
			{...props}
		/>
	);
}

function SheetDescription({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
	return (
		<SheetPrimitive.Description
			data-slot="sheet-description"
			className={cn("text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

export {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
};
